/*
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License
 */

/*
 * Autoscaler Poller function
 *
 * * Polls one or more CloudSQL instances for metrics.
 * * Sends metrics to Scaler to determine if an instance needs to be autoscaled
 */

const axios = require("axios").default;
// eslint-disable-next-line no-unused-vars -- for type checking only.
const express = require("express");
const monitoring = require("@google-cloud/monitoring");
const { PubSub } = require("@google-cloud/pubsub");
const { google } = require("googleapis");
const { logger } = require("../../autoscaler-common/logger");
const Counters = require("./counters.js");
const { AutoscalerUnits } = require("../../autoscaler-common/types");
const assertDefined = require("../../autoscaler-common/assertDefined");
const { version: packageVersion } = require("../../../package.json");
const { ConfigValidator } = require("./config-validator");

/**
 * @typedef {import('../../autoscaler-common/types').AutoscalerCloudSQL
 * } AutoscalerCloudSQL
 * @typedef {import('../../autoscaler-common/types').CloudSQLConfig
 * } CloudSQLConfig
 * @typedef {import('../../autoscaler-common/types').CloudSQLMetadata
 * } CloudSQLMetadata
 * @typedef {import('../../autoscaler-common/types').CloudSQLMetricValue
 * } CloudSQLMetric
 * @typedef {import('../../autoscaler-common/types').CloudSQLMetric
 * } CloudSQLMetric
 */

// GCP service clients
const metricsClient = new monitoring.MetricServiceClient();
const pubSub = new PubSub();
const sqlAdmin = google.sqladmin("v1beta4");

const configValidator = new ConfigValidator();

const baseDefaults = {
  units: AutoscalerUnits.VCPU,
  scaleOutCoolingMinutes: 5,
  scaleInCoolingMinutes: 5,
  scalingMethod: "FIXED",
};
const vcpuDefaults = {
  units: AutoscalerUnits.VCPU,
  minSize: 2,
  maxSize: 8,
  stepSize: 2,
  overloadStepSize: 2,
};
const metricDefaults = {
  period: 60,
  aligner: "ALIGN_MAX",
  reducer: "REDUCE_SUM",
};
const DEFAULT_THRESHOLD_MARGIN = 5;

/**
 * Build the list of metrics to request
 *
 * @param {string} projectId
 * @param {string} instanceId
 * @return {CloudSQLMetric[]} metrics to request
 */
function buildMetrics(projectId, instanceId) {
  // Recommended alerting policies
  // https://cloud.google.com/sql/docs/mysql/use-system-insights
  /** @type {CloudSQLMetric[]} */
  const metrics = [
    {
      name: "cpu",
      filter:
        createBaseFilter(projectId, instanceId) +
        "metric.type=" +
        '"cloudsql.googleapis.com/database/cpu/utilization" ',
      reducer: "REDUCE_SUM",
      aligner: "ALIGN_MAX",
      period: 60,
      regional_threshold: 65,
      multi_regional_threshold: 45,
    },
  ];

  return metrics;
}

/**
 * Creates the base filter that should be prepended to all metric filters
 * @param {string} projectId
 * @param {string} instanceId
 * @return {string} filter
 */
function createBaseFilter(projectId, instanceId) {
  return (
    'resource.labels.database_id="' +
    projectId +
    ":" +
    instanceId +
    '" AND ' +
    'resource.type="cloudsql_database" AND ' +
    'project="' +
    projectId +
    '" AND '
  );
}

/**
 * Checks to make sure required fields are present and populated
 *
 * @param {CloudSQLMetric} metric
 * @param {string} projectId
 * @param {string} instanceId
 * @return {boolean}
 */
function validateCustomMetric(metric, projectId, instanceId) {
  if (!metric.name) {
    logger.info({
      message: "Missing name parameter for custom metric.",
      projectId: projectId,
      instanceId: instanceId,
    });
    return false;
  }

  if (!metric.filter) {
    logger.info({
      message: "Missing filter parameter for custom metric.",
      projectId: projectId,
      instanceId: instanceId,
    });
    return false;
  }

  if (!(metric.regional_threshold > 0 || metric.multi_regional_threshold > 0)) {
    logger.info({
      message:
        "Missing regional_threshold or multi_multi_regional_threshold " +
        "parameter for custom metric.",
      projectId: projectId,
      instanceId: instanceId,
    });
    return false;
  }

  return true;
}

/**
 * Get max value of metric over a window
 *
 * @param {string} projectId
 * @param {string} cloudSQLInstanceId
 * @param {CloudSQLMetric} metric
 * @return {Promise<[number,string]>}
 */
function getMaxMetricValue(projectId, cloudSQLInstanceId, metric) {
  const metricWindow = 5;
  logger.debug({
    message: `Get max ${metric.name} from ${projectId}/${cloudSQLInstanceId} over ${metricWindow} minutes.`,
    projectId: projectId,
    instanceId: cloudSQLInstanceId,
  });

  /** @type {monitoring.protos.google.monitoring.v3.IListTimeSeriesRequest} */
  const request = {
    name: "projects/" + projectId,
    filter: metric.filter,
    interval: {
      startTime: {
        seconds: Date.now() / 1000 - metric.period * metricWindow,
      },
      endTime: {
        seconds: Date.now() / 1000,
      },
    },
    aggregation: {
      alignmentPeriod: {
        seconds: metric.period,
      },
      // @ts-ignore
      crossSeriesReducer: metric.reducer,
      // @ts-ignore
      perSeriesAligner: metric.aligner,
      // groupByFields: ["resource.location"],
    },
    view: "FULL",
  };

  return metricsClient.listTimeSeries(request).then((metricResponses) => {
    const resources = metricResponses[0];
    let maxValue = 0.0;
    let maxLocation = "regional";

    for (const resource of resources) {
      for (const point of assertDefined(resource.points)) {
        const value = assertDefined(point.value?.doubleValue) * 100;
        if (value > maxValue) {
          maxValue = value;
          if (resource.resource?.labels?.location) {
            maxLocation = resource.resource.labels.location;
          }
        }
      }
    }

    return [maxValue, maxLocation];
  });
}

/**
 * Get metadata for CloudSQL instance
 *
 * @param {string} projectId
 * @param {string} cloudSQLInstanceId
 * @return {Promise<CloudSQLMetadata>}
 */
async function getCloudSQLMetadata(projectId, cloudSQLInstanceId) {
  logger.info({
    message: `----- ${projectId}/${cloudSQLInstanceId}: Getting Metadata -----`,
    projectId: projectId,
    instanceId: cloudSQLInstanceId,
  });

  // Authenticate using Application Default Credentials
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/sqlservice.admin"],
  });
  const authClient = await auth.getClient();

  const request = {
    project: projectId,
    instance: cloudSQLInstanceId,
    auth: authClient,
  };

  const results = await Promise.all([
    sqlAdmin.databases.list(request),
    sqlAdmin.instances.get(request),
  ]);
  const numDatabases = results[0].data?.items?.length;
  const metadata = results[1].data;

  logger.info({
    message: `DisplayName:     ${metadata.name}`,
    projectId: projectId,
    instanceId: cloudSQLInstanceId,
  });
  logger.info({
    message: `Tier:     ${metadata.settings.tier}`,
    projectId: projectId,
    instanceId: cloudSQLInstanceId,
  });
  logger.info({
    message: `Databases:     ${numDatabases}`,
    projectId: projectId,
    instanceId: cloudSQLInstanceId,
  });

  /** @type {CloudSQLMetadata}     */
  const cloudSQLmetadata = {
    currentSize: parseInt(metadata.settings.tier.match(/\d+$/)[0]),
    regional: metadata.settings.availabilityType.startsWith("REGIONAL"),
    currentNumDatabases: numDatabases,
  };
  return cloudSQLmetadata;
}

/**
 * Post a message to PubSub with the cloudSQL instance and metrics.
 *
 * @param {AutoscalerCloudSQL} cloudsql
 * @param {CloudSQLMetric[]} metrics
 * @return {Promise<Void>}
 */
async function postPubSubMessage(cloudsql, metrics) {
  const topic = pubSub.topic(assertDefined(cloudsql.scalerPubSubTopic));

  cloudsql.metrics = metrics;
  const messageBuffer = Buffer.from(JSON.stringify(cloudsql), "utf8");

  return topic
    .publishMessage({ data: messageBuffer })
    .then(() =>
      logger.info({
        message: `----- Published message to topic: ${cloudsql.scalerPubSubTopic}`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
        payload: cloudsql,
      }),
    )
    .catch((err) => {
      logger.error({
        message: `An error occurred when publishing the message to ${cloudsql.scalerPubSubTopic}: ${err}`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
        payload: cloudsql,
        err: err,
      });
    });
}

/**
 * Calls the Scaler cloud function by HTTP POST.
 *
 * @param {CloudSQLConfig} cloudsql
 * @param {CloudSQLMetric[]} metrics
 * @return {Promise<Void>}
 */
async function callScalerHTTP(cloudsql, metrics) {
  cloudsql.scalerURL ||= "http://scaler";
  const url = new URL("/metrics", cloudsql.scalerURL);

  cloudsql.metrics = metrics;

  return axios
    .post(url.toString(), cloudsql)
    .then((response) => {
      logger.info({
        message: `----- Published message to scaler, response ${response.statusText}`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
        payload: cloudsql,
      });
    })
    .catch((err) => {
      logger.error({
        message: `An error occurred when calling the scaler: ${err}`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
        payload: cloudsql,
        err: err,
      });
    });
}

/**
 * Enrich the paylod by adding information from the config.
 *
 * @param {string} payload
 * @return {Promise<AutoscalerCloudSQL[]>} enriched payload
 */
async function parseAndEnrichPayload(payload) {
  const cloudsqls = await configValidator.parseAndAssertValidConfig(payload);
  /** @type {AutoscalerCloudSQL[]} */
  const cloudsqlsFound = [];

  for (let sIdx = 0; sIdx < cloudsqls.length; sIdx++) {
    const metricOverrides =
      /** @type {CloudSQLMetric[]} */
      (cloudsqls[sIdx].metrics);

    // assemble the config
    // merge in the defaults
    cloudsqls[sIdx] = { ...baseDefaults, ...cloudsqls[sIdx] };

    cloudsqls[sIdx].units = cloudsqls[sIdx].units?.toUpperCase();
    // handle processing units/nodes defaults
    if (cloudsqls[sIdx].units == "VCPU") {
      // merge in the vcpu unit defaults
      cloudsqls[sIdx] = { ...vcpuDefaults, ...cloudsqls[sIdx] };
    } else {
      throw new Error(
        `INVALID CONFIG: ${cloudsqls[sIdx].units} is invalid. Valid values are VCPU`,
      );
    }

    // assemble the metrics
    cloudsqls[sIdx].metrics = buildMetrics(
      cloudsqls[sIdx].projectId,
      cloudsqls[sIdx].instanceId,
    );
    // merge in custom thresholds
    if (metricOverrides != null) {
      for (let oIdx = 0; oIdx < metricOverrides.length; oIdx++) {
        const mIdx = cloudsqls[sIdx].metrics.findIndex(
          (x) => x.name === metricOverrides[oIdx].name,
        );
        if (mIdx != -1) {
          cloudsqls[sIdx].metrics[mIdx] = {
            ...cloudsqls[sIdx].metrics[mIdx],
            ...metricOverrides[oIdx],
          };
        } else {
          /** @type {CloudSQLMetric} */
          const metric = { ...metricDefaults, ...metricOverrides[oIdx] };
          if (
            validateCustomMetric(
              metric,
              cloudsqls[sIdx].projectId,
              cloudsqls[sIdx].instanceId,
            )
          ) {
            metric.filter =
              createBaseFilter(
                cloudsqls[sIdx].projectId,
                cloudsqls[sIdx].instanceId,
              ) + metric.filter;
            cloudsqls[sIdx].metrics.push(metric);
          }
        }
      }
    }

    // merge in the current CloudSQL state
    try {
      cloudsqls[sIdx] = {
        ...cloudsqls[sIdx],
        ...(await getCloudSQLMetadata(
          cloudsqls[sIdx].projectId,
          cloudsqls[sIdx].instanceId,
        )),
      };
      cloudsqlsFound.push(cloudsqls[sIdx]);
    } catch (err) {
      logger.error({
        message: `Unable to retrieve CloudSQL metadata for ${cloudsqls[sIdx].projectId}/${cloudsqls[sIdx].instanceId}: ${err}`,
        projectId: cloudsqls[sIdx].projectId,
        instanceId: cloudsqls[sIdx].instanceId,
        err: err,
        payload: cloudsqls[sIdx],
      });
    }
  }

  return cloudsqlsFound;
}

/**
 * Retrive the metrics for a cloudsql instance
 *
 * @param {AutoscalerCloudSQL} cloudsql
 * @return {Promise<CloudSQLMetric[]>} metric values
 */
async function getMetrics(cloudsql) {
  logger.info({
    message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: Getting Metrics -----`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
  });
  /** @type {CloudSQLMetric[]} */
  const metrics = [];
  for (const m of cloudsql.metrics) {
    const metric = /** @type {CloudSQLMetric} */ (m);
    const [maxMetricValue, maxLocation] = await getMaxMetricValue(
      cloudsql.projectId,
      cloudsql.instanceId,
      metric,
    );

    let threshold;
    let margin;
    if (cloudsql.regional) {
      threshold = metric.regional_threshold;
      if (!metric.hasOwnProperty("regional_margin")) {
        metric.regional_margin = DEFAULT_THRESHOLD_MARGIN;
      }
      margin = metric.regional_margin;
    } else {
      threshold = metric.multi_regional_threshold;
      if (!metric.hasOwnProperty("multi_regional_margin")) {
        metric.multi_regional_margin = DEFAULT_THRESHOLD_MARGIN;
      }
      margin = metric.multi_regional_margin;
    }

    logger.debug({
      message: `  ${metric.name} = ${maxMetricValue}, threshold = ${threshold}, margin = ${margin}, location = ${maxLocation}`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
    });

    /** @type {CloudSQLMetric} */
    const metricsObject = {
      name: metric.name,
      threshold: threshold,
      margin: assertDefined(margin),
      value: maxMetricValue,
    };
    metrics.push(metricsObject);
  }
  return metrics;
}

/**
 * Forwards the metrics
 * @param {function(
 *    AutoscalerCloudSQL,
 *    CloudSQLMetric[]): Promise<Void>} forwarderFunction
 * @param {AutoscalerCloudSQL[]} cloudsqls config objects
 * @return {Promise<Void>}
 */
async function forwardMetrics(forwarderFunction, cloudsqls) {
  for (const cloudsql of cloudsqls) {
    try {
      const metrics = await getMetrics(cloudsql);
      await forwarderFunction(cloudsql, metrics); // Handles exceptions
      await Counters.incPollingSuccessCounter(cloudsql);
    } catch (err) {
      logger.error({
        message: `Unable to retrieve metrics for ${cloudsql.projectId}/${cloudsql.instanceId}: ${err}`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
        payload: cloudsql,
        err: err,
      });
      await Counters.incPollingFailedCounter(cloudsql);
    }
  }
}

/**
 * Aggregate metrics for a List of cloudsql config
 *
 * @param {AutoscalerCloudSQL[]} cloudsqls
 * @return {Promise<AutoscalerCloudSQL[]>} aggregatedMetrics
 */
async function aggregateMetrics(cloudsqls) {
  const aggregatedMetrics = [];
  for (const cloudsql of cloudsqls) {
    try {
      cloudsql.metrics = await getMetrics(cloudsql);
      aggregatedMetrics.push(cloudsql);
      await Counters.incPollingSuccessCounter(cloudsql);
    } catch (err) {
      logger.error({
        message: `Unable to retrieve metrics for ${cloudsql.projectId}/${cloudsql.instanceId}: ${err}`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
        cloudsql: cloudsql,
        err: err,
      });
      await Counters.incPollingFailedCounter(cloudsql);
    }
  }
  return aggregatedMetrics;
}

/**
 * Handle a PubSub message and check if scaling is required
 *
 * @param {{data: string}} pubSubEvent
 * @param {*} context
 */
async function checkCloudSQLScaleMetricsPubSub(pubSubEvent, context) {
  try {
    const payload = Buffer.from(pubSubEvent.data, "base64").toString();
    try {
      const cloudsqls = await parseAndEnrichPayload(payload);
      logger.debug({
        message: "Autoscaler poller started (PubSub).",
        payload: cloudsqls,
      });
      await forwardMetrics(postPubSubMessage, cloudsqls);
      await Counters.incRequestsSuccessCounter();
    } catch (err) {
      logger.error({
        message: `An error occurred in the Autoscaler poller function (PubSub): ${err}`,
        payload: payload,
        err: err,
      });
      await Counters.incRequestsFailedCounter();
    }
  } catch (err) {
    logger.error({
      message: `An error occurred parsing pubsub payload: ${err}`,
      payload: pubSubEvent.data,
      err: err,
    });
    await Counters.incRequestsFailedCounter();
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * For testing with: https://cloud.google.com/functions/docs/functions-framework
 * @param {express.Request} req
 * @param {express.Response} res
 */
async function checkCloudSQLScaleMetricsHTTP(req, res) {
  const payload =
    "[{ " +
    '  "projectId": "my-cloudsql-project", ' +
    '  "instanceId": "my-cloudsql-instance", ' +
    '  "scalerPubSubTopic": ' +
    '     "projects/my-project/topics/test-scaling", ' +
    '  "minSize": 1, ' +
    '  "maxSize": 3, ' +
    '  "stateProjectId" : "my-project"' +
    "}]";
  try {
    const cloudsqls = await parseAndEnrichPayload(payload);
    await forwardMetrics(postPubSubMessage, cloudsqls);
    res.status(200).end();
    await Counters.incRequestsSuccessCounter();
  } catch (err) {
    logger.error({
      message: `An error occurred in the Autoscaler poller function (HTTP): ${err}`,
      payload: payload,
      err: err,
    });
    res.status(500).contentType("text/plain").end("An Exception occurred");
    await Counters.incRequestsFailedCounter();
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * HTTP test
 *
 * @param {string} payload
 */
async function checkCloudSQLScaleMetricsJSON(payload) {
  try {
    const cloudsqls = await parseAndEnrichPayload(payload);
    logger.debug({
      message: "Autoscaler poller started (JSON/HTTP).",
      payload: cloudsqls,
    });
    await forwardMetrics(callScalerHTTP, cloudsqls);
    await Counters.incRequestsSuccessCounter();
  } catch (err) {
    logger.error({
      message: `An error occurred in the Autoscaler poller function (JSON/HTTP): ${err}`,
      payload: payload,
      err: err,
    });
    await Counters.incRequestsFailedCounter();
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * Entrypoint for Local config.
 *
 * @param {string} payload
 * @return {Promise<AutoscalerCloudSQL[]>}
 */
async function checkCloudSQLScaleMetricsLocal(payload) {
  try {
    const cloudsqls = await parseAndEnrichPayload(payload);
    logger.debug({
      message: "Autoscaler poller started (JSON/local).",
      payload: cloudsqls,
    });
    const metrics = await aggregateMetrics(cloudsqls);
    await Counters.incRequestsSuccessCounter();
    return metrics;
  } catch (err) {
    logger.error({
      message: `An error occurred in the Autoscaler poller function (JSON/Local): ${err}`,
      payload: payload,
      err: err,
    });
    await Counters.incRequestsFailedCounter();
    return [];
  } finally {
    await Counters.tryFlush();
  }
}

module.exports = {
  checkCloudSQLScaleMetricsPubSub,
  checkCloudSQLScaleMetricsHTTP,
  checkCloudSQLScaleMetricsJSON,
  checkCloudSQLScaleMetricsLocal,
};
