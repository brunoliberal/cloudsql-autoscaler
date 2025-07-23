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
 * Autoscaler Scaler function
 *
 * * Receives metrics from the Autoscaler Poller pertaining to a single CloudSQL
 * instance.
 * * Determines if the CloudSQL instance can be autoscaled
 * * Selects a scaling method, and gets a number of suggested nodes
 * * Autoscales the CloudSQL instance by the number of suggested nodes
 */
// eslint-disable-next-line no-unused-vars -- for type checking only.
const express = require("express");
// eslint-disable-next-line no-unused-vars -- for type checking only.
const { google: GoogleApis, sqladmin_v1: cloudsqlRest } = require("googleapis");
const Counters = require("./counters.js");
const sanitize = require("sanitize-filename");
const { convertMillisecToHumanReadable } = require("./utils.js");
const { logger } = require("../../autoscaler-common/logger");
const { publishProtoMsgDownstream } = require("./utils.js");
const State = require("./state.js");
const fs = require("fs");
const { version: packageVersion } = require("../../../package.json");

/**
 * @typedef {import('../../autoscaler-common/types').AutoscalerCloudSQL
 * } AutoscalerCloudSQL
 * @typedef {import('./state.js').StateData} StateData
 */

const cloudSQLRestApi = GoogleApis.sqladmin({
  version: "v1",
  auth: new GoogleApis.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/sqlservice.admin"],
  }),
});

/**
 * Get scaling method function by name.
 *
 * @param {AutoscalerCloudSQL} cloudsql
 * @return {{
 *  calculateSize: function(AutoscalerCloudSQL):number
 * }}
 */
function getScalingMethod(cloudsql) {
  const SCALING_METHODS_FOLDER = "./scaling-methods/";
  const DEFAULT_METHOD_NAME = "FIXED";

  // sanitize the method name before using
  // to prevent risk of directory traversal.
  const methodName = sanitize(cloudsql.scalingMethod);
  let scalingMethod;
  try {
    scalingMethod = require(SCALING_METHODS_FOLDER + methodName.toLowerCase());
  } catch (err) {
    logger.warn({
      message: `Unknown scaling method '${methodName}'`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
    });
    scalingMethod = require(
      SCALING_METHODS_FOLDER + DEFAULT_METHOD_NAME.toLowerCase(),
    );
    cloudsql.scalingMethod = DEFAULT_METHOD_NAME;
  }
  logger.info({
    message: `Using scaling method: ${cloudsql.scalingMethod}`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
  });
  return scalingMethod;
}

/**
 * Scale the specified CloudSQL instance to the specified size
 *
 * @param {AutoscalerCloudSQL} cloudsql
 * @param {number} suggestedSize
 * @return {Promise<string?>} operationId
 */
async function scaleCloudSQLInstance(cloudsql, suggestedSize) {
  logger.info({
    message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: Scaling CloudSQL instance to ${suggestedSize} ${cloudsql.units} -----`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
  });

  const TIER_PREFIX = "db-perf-optimized-N-";

  const { data: instance } = await cloudSQLRestApi.instances.get({
    project: cloudsql.projectId,
    instance: cloudsql.instanceId,
  });

  instance.settings.tier = TIER_PREFIX + suggestedSize;

  const { data: operation } = await cloudSQLRestApi.instances.update({
    project: cloudsql.projectId,
    instance: cloudsql.instanceId,
    resource: instance,
  });
  logger.debug({
    message: `CloudSQL started the scaling operation: ${operation.name}`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
  });

  return operation.name || null;
}

/**
 * Publish scaling PubSub event.
 *
 * @param {string} eventName
 * @param {AutoscalerCloudSQL} cloudsql
 * @param {number} suggestedSize
 * @return {Promise<Void>}
 */
async function publishDownstreamEvent(eventName, cloudsql, suggestedSize) {
  const message = {
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
    currentSize: cloudsql.currentSize,
    suggestedSize: suggestedSize,
    units: cloudsql.units,
    metrics: cloudsql.metrics,
  };

  return publishProtoMsgDownstream(
    eventName,
    message,
    cloudsql.downstreamPubSubTopic,
  );
}

/**
 * Test to see if CloudSQL instance is in post-scale cooldown.
 *
 * @param {AutoscalerCloudSQL} cloudsql
 * @param {number} suggestedSize
 * @param {StateData} autoscalerState
 * @param {number} now timestamp in millis since epoch
 * @return {boolean}
 */
function withinCooldownPeriod(cloudsql, suggestedSize, autoscalerState, now) {
  const MS_IN_1_MIN = 60000;
  const scaleOutSuggested = suggestedSize - cloudsql.currentSize > 0;
  let cooldownPeriodOver;
  let duringOverload = "";

  logger.debug({
    message: `-----  ${cloudsql.projectId}/${cloudsql.instanceId}: Verifying if scaling is allowed -----`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
  });

  // Use the operation completion time if present, else use the launch time
  // of the scaling op.
  const lastScalingMillisec = autoscalerState.lastScalingCompleteTimestamp
    ? autoscalerState.lastScalingCompleteTimestamp
    : autoscalerState.lastScalingTimestamp;

  const operation = scaleOutSuggested
    ? {
        description: "scale out",
        coolingMillisec: cloudsql.scaleOutCoolingMinutes * MS_IN_1_MIN,
      }
    : {
        description: "scale in",
        coolingMillisec: cloudsql.scaleInCoolingMinutes * MS_IN_1_MIN,
      };

  if (cloudsql.isOverloaded) {
    if (cloudsql.overloadCoolingMinutes == null) {
      cloudsql.overloadCoolingMinutes = cloudsql.scaleOutCoolingMinutes;
      logger.info({
        message:
          "\tNo cooldown period defined for overload situations. " +
          `Using default: ${cloudsql.scaleOutCoolingMinutes} minutes`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
      });
    }
    operation.coolingMillisec = cloudsql.overloadCoolingMinutes * MS_IN_1_MIN;
    duringOverload = " during overload";
  }

  if (lastScalingMillisec == 0) {
    cooldownPeriodOver = true;
    logger.debug({
      message: `\tNo previous scaling operation found for this CloudSQL instance`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
    });
  } else {
    const elapsedMillisec = now - lastScalingMillisec;
    cooldownPeriodOver = elapsedMillisec >= operation.coolingMillisec;

    logger.debug({
      message: `\tLast scaling operation was ${convertMillisecToHumanReadable(elapsedMillisec)} ago.`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
    });
    logger.debug({
      message: `\tCooldown period for ${operation.description}${duringOverload} is ${convertMillisecToHumanReadable(
        operation.coolingMillisec,
      )}.`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
    });

    // During a three-hour window, only the first scale-down benefits
    // from near-zero downtime; later ones face regular downtime.
    const isPrevScaleIn =
      autoscalerState.scalingPreviousSize >
      autoscalerState.scalingRequestedSize;
    if (
      !scaleOutSuggested &&
      isPrevScaleIn &&
      elapsedMillisec < 180 * MS_IN_1_MIN
    ) {
      cooldownPeriodOver = false;
      logger.info({
        message: `\tLast scale-down operation was ${convertMillisecToHumanReadable(elapsedMillisec)} ago. Another scale-down not allowed within 3h window`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
        payload: cloudsql,
      });
    }
  }

  if (cooldownPeriodOver) {
    logger.info({
      message: `\t=> Autoscale allowed`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
    });
    return false;
  } else {
    logger.info({
      message: `\t=> Autoscale NOT allowed yet`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
    });
    return true;
  }
}

/**
 * Get Suggested size from config using scalingMethod
 * @param {AutoscalerCloudSQL} cloudsql
 * @return {number}
 */
function getSuggestedSize(cloudsql) {
  const scalingMethod = getScalingMethod(cloudsql);
  return scalingMethod.calculateSize(cloudsql);
}

/**
 * Process the request to check a cloudsql instance for scaling
 *
 * @param {AutoscalerCloudSQL} cloudsql
 * @param {State} autoscalerState
 */
async function processScalingRequest(cloudsql, autoscalerState) {
  logger.info({
    message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: Scaling request received`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
    payload: cloudsql,
  });

  // Check for ongoing LRO
  const savedState = await readStateCheckOngoingLRO(cloudsql, autoscalerState);

  const suggestedSize = getSuggestedSize(cloudsql);
  if (
    suggestedSize === cloudsql.currentSize &&
    cloudsql.currentSize === cloudsql.maxSize
  ) {
    logger.info({
      message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: has ${cloudsql.currentSize} ${cloudsql.units}, no scaling possible - at maxSize`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
      payload: cloudsql,
    });
    await Counters.incScalingDeniedCounter(cloudsql, suggestedSize, "MAX_SIZE");
    return;
  } else if (suggestedSize === cloudsql.currentSize) {
    logger.info({
      message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: has ${cloudsql.currentSize} ${cloudsql.units}, no scaling needed - at current size or minSize`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
      payload: cloudsql,
    });
    await Counters.incScalingDeniedCounter(
      cloudsql,
      suggestedSize,
      "CURRENT_SIZE",
    );
    return;
  }

  if (
    savedState.scalingOperationId &&
    savedState.scalingRequestedSize !== suggestedSize
  ) {
    // There is an ongoing scaling operation,
    // but the scaling calculations have evaluated a different size to what
    // was previously requested.
    logger.warn({
      message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: has ongoing scaling operation to ${savedState.scalingRequestedSize} ${cloudsql.units}`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
      payload: cloudsql,
    });
  }

  if (!savedState.scalingOperationId) {
    // no ongoing operation, check cooldown...
    if (
      !withinCooldownPeriod(
        cloudsql,
        suggestedSize,
        savedState,
        autoscalerState.now,
      )
    ) {
      let eventType;
      try {
        const operationId = await scaleCloudSQLInstance(
          cloudsql,
          suggestedSize,
        );
        await autoscalerState.updateState({
          ...savedState,
          scalingOperationId: operationId,
          lastScalingTimestamp: autoscalerState.now,
          lastScalingCompleteTimestamp: null,
          scalingMethod: cloudsql.scalingMethod,
          scalingPreviousSize: cloudsql.currentSize,
          scalingRequestedSize: suggestedSize,
        });
        eventType = "SCALING";
      } catch (err) {
        logger.error({
          message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: Unsuccessful scaling attempt: ${err}`,
          projectId: cloudsql.projectId,
          instanceId: cloudsql.instanceId,
          payload: cloudsql,
          err: err,
        });
        eventType = "SCALING_FAILURE";
        await Counters.incScalingFailedCounter(
          cloudsql,
          cloudsql.scalingMethod,
          cloudsql.currentSize,
          suggestedSize,
        );
      }
      await publishDownstreamEvent(eventType, cloudsql, suggestedSize);
    } else {
      logger.info({
        message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: has ${cloudsql.currentSize} ${cloudsql.units}, no scaling possible - within cooldown period`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
        payload: cloudsql,
      });
      await Counters.incScalingDeniedCounter(
        cloudsql,
        suggestedSize,
        "WITHIN_COOLDOWN",
      );
    }
  } else {
    logger.info({
      message:
        `----- ${cloudsql.projectId}/${cloudsql.instanceId}: has ${cloudsql.currentSize} ${cloudsql.units}, no scaling possible ` +
        `- last scaling operation to ${savedState.scalingRequestedSize} ${cloudsql.units} still in progress. Started: ${convertMillisecToHumanReadable(
          autoscalerState.now - savedState.lastScalingTimestamp,
        )} ago).`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
      payload: cloudsql,
    });
    await Counters.incScalingDeniedCounter(
      cloudsql,
      suggestedSize,
      "IN_PROGRESS",
    );
  }
}

/**
 * Handle scale request from a PubSub event.
 *
 * Called by Cloud Run functions Scaler deployment.
 *
 * @param {{data:string}} pubSubEvent -- a CloudEvent object.
 * @param {*} context
 */
async function scaleCloudSQLInstancePubSub(pubSubEvent, context) {
  try {
    const payload = Buffer.from(pubSubEvent.data, "base64").toString();
    const cloudsql = JSON.parse(payload);
    try {
      const state = State.buildFor(cloudsql);

      await processScalingRequest(cloudsql, state);
      await state.close();
      await Counters.incRequestsSuccessCounter();
    } catch (err) {
      logger.error({
        message: `Failed to process scaling request: ${err}`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
        payload: cloudsql,
        err: err,
      });
      await Counters.incRequestsFailedCounter();
    }
  } catch (err) {
    logger.error({
      message: `Failed to parse pubSub scaling request: ${err}`,
      payload: pubSubEvent.data,
      err: err,
    });
    await Counters.incRequestsFailedCounter();
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * Test to handle scale request from a HTTP call with fixed payload
 * For testing with: https://cloud.google.com/functions/docs/functions-framework
 * @param {express.Request} req
 * @param {express.Response} res
 */
async function scaleCloudSQLInstanceHTTP(req, res) {
  try {
    const payload = fs.readFileSync(
      "src/scaler/scaler-core/test/samples/parameters.json",
      "utf-8",
    );
    const cloudsql = JSON.parse(payload);
    try {
      const state = State.buildFor(cloudsql);

      await processScalingRequest(cloudsql, state);
      await state.close();

      res.status(200).end();
      await Counters.incRequestsSuccessCounter();
    } catch (err) {
      logger.error({
        message: `Failed to process scaling request: ${err}`,
        payload: payload,
        err: err,
      });
      res.status(500).contentType("text/plain").end("An Exception occurred");
      await Counters.incRequestsFailedCounter();
    }
  } catch (err) {
    logger.error({
      message: `Failed to parse http scaling request: ${err}`,
      err: err,
    });
    await Counters.incRequestsFailedCounter();
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * Handle scale request from a HTTP call with JSON payload
 *
 * Called by the Scaler service on GKE deployments
 *
 * @param {express.Request} req
 * @param {express.Response} res
 */
async function scaleCloudSQLInstanceJSON(req, res) {
  const cloudsql = req.body;
  try {
    const state = State.buildFor(cloudsql);

    await processScalingRequest(cloudsql, state);
    await state.close();

    res.status(200).end();
    await Counters.incRequestsSuccessCounter();
  } catch (err) {
    logger.error({
      message: `Failed to process scaling request: ${err}`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
      payload: cloudsql,
      err: err,
    });
    res.status(500).contentType("text/plain").end("An Exception occurred");
    await Counters.incRequestsFailedCounter();
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * Handle scale request from local function call
 *
 * Called by unified poller/scaler on GKE deployments
 *
 * @param {AutoscalerCloudSQL} cloudsql
 */
async function scaleCloudSQLInstanceLocal(cloudsql) {
  try {
    const state = State.buildFor(cloudsql);

    await processScalingRequest(cloudsql, state);
    await state.close();
    await Counters.incRequestsSuccessCounter();
  } catch (err) {
    logger.error({
      message: `Failed to process scaling request: ${err}`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
      payload: cloudsql,
      err: err,
    });
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * Read state and check status of any LRO...
 *
 *
 * @param {AutoscalerCloudSQL} cloudsql
 * @param {State} autoscalerState
 * @return {Promise<StateData>}
 */
async function readStateCheckOngoingLRO(cloudsql, autoscalerState) {
  const savedState = await autoscalerState.get();

  if (!savedState.scalingOperationId) {
    // no LRO ongoing.
    return savedState;
  }

  /** @type {?cloudsqlRest.Schema$Operation} */
  try {
    // Check LRO status using REST API.
    const { data: operationState } = await cloudSQLRestApi.operations.get({
      project: cloudsql.projectId,
      operation: savedState.scalingOperationId,
    });

    if (!operationState) {
      throw new Error(
        `GetOperation(${savedState.scalingOperationId}) returned no results`,
      );
    }
    // Check operation type
    if (
      !operationState.operationType ||
      operationState.operationType !== "UPDATE"
    ) {
      throw new Error(
        `GetOperation(${savedState.scalingOperationId}) contained no UPDATE operation`,
      );
    }

    // scalingRequestedSize should be in the savedState object
    if (savedState.scalingRequestedSize == null) {
      // CloudSQL doesn't provive the scaling request in the operation response. fallback to currentSize.
      savedState.scalingRequestedSize = cloudsql.currentSize;
    }

    const requestedSize = { vcpuCount: savedState.scalingRequestedSize };
    const displayedRequestedSize = JSON.stringify(requestedSize);

    if (operationState.status == "DONE") {
      if (!operationState.error) {
        // Completed successfully.
        const endTimestamp =
          operationState.endTime == null
            ? 0
            : Date.parse(operationState.endTime);
        logger.info({
          message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: Last scaling request for ${displayedRequestedSize} SUCCEEDED. Started: ${operationState.startTime}, completed: ${operationState.endTime}`,
          projectId: cloudsql.projectId,
          instanceId: cloudsql.instanceId,
          requestedSize: requestedSize,
          payload: cloudsql,
        });

        // Set completion time in savedState
        if (endTimestamp) {
          savedState.lastScalingCompleteTimestamp = endTimestamp;
        } else {
          // invalid end date, assume start date...
          logger.warn(
            `Failed to parse operation endTime : ${operationState.endTime}`,
          );
          savedState.lastScalingCompleteTimestamp =
            savedState.lastScalingTimestamp;
        }

        // Record success counters.
        await Counters.recordScalingDuration(
          savedState.lastScalingCompleteTimestamp -
            savedState.lastScalingTimestamp,
          cloudsql,
          savedState.scalingMethod,
          savedState.scalingPreviousSize,
          savedState.scalingRequestedSize,
        );
        await Counters.incScalingSuccessCounter(
          cloudsql,
          savedState.scalingMethod,
          savedState.scalingPreviousSize,
          savedState.scalingRequestedSize,
        );

        // Clear last scaling operation from savedState.
        savedState.scalingOperationId = null;
        savedState.scalingMethod = null;
        savedState.scalingPreviousSize = null;
        savedState.scalingRequestedSize = null;
      } else {
        // Last operation failed with an error
        logger.error({
          message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: Last scaling request for ${displayedRequestedSize} FAILED: ${operationState.error?.errors[0].message}. Started: ${operationState.startTime}, completed: ${operationState.endTime}`,
          projectId: cloudsql.projectId,
          instanceId: cloudsql.instanceId,
          requestedSize: requestedSize,
          error: operationState.error,
          payload: cloudsql,
        });

        await Counters.incScalingFailedCounter(
          cloudsql,
          savedState.scalingMethod,
          savedState.scalingPreviousSize,
          savedState.scalingRequestedSize,
        );
        // Clear last scaling operation from savedState.
        savedState.lastScalingCompleteTimestamp = 0;
        savedState.lastScalingTimestamp = 0;
        savedState.scalingOperationId = null;
        savedState.scalingMethod = null;
        savedState.scalingPreviousSize = null;
        savedState.scalingRequestedSize = null;
      }
      return savedState;
    } else {
      // last scaling operation is still ongoing
      logger.info({
        message: `----- ${cloudsql.projectId}/${cloudsql.instanceId}: Last scaling request for ${displayedRequestedSize} IN PROGRESS. Started: ${operationState?.startTime}`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
        requestedSize: requestedSize,
        payload: cloudsql,
      });

      return savedState;
    }
  } catch (err) {
    // Fallback - LRO.get() API failed or returned invalid status.
    // Assume complete.
    logger.error({
      message: `Failed to retrieve state of operation, assume completed. ID: ${savedState.scalingOperationId}: ${err}`,
      err: err,
    });
    savedState.scalingOperationId = null;
    savedState.lastScalingCompleteTimestamp = savedState.lastScalingTimestamp;
    // Record success counters.
    await Counters.recordScalingDuration(
      savedState.lastScalingCompleteTimestamp - savedState.lastScalingTimestamp,
      cloudsql,
      savedState.scalingMethod,
      savedState.scalingPreviousSize,
      savedState.scalingRequestedSize,
    );
    await Counters.incScalingSuccessCounter(
      cloudsql,
      savedState.scalingMethod,
      savedState.scalingPreviousSize,
      savedState.scalingRequestedSize,
    );

    savedState.scalingMethod = null;
    savedState.scalingPreviousSize = null;
    savedState.scalingRequestedSize = null;

    return savedState;
  } finally {
    // Update saved state in storage.
    await autoscalerState.updateState(savedState);
  }
}

module.exports = {
  scaleCloudSQLInstanceHTTP: scaleCloudSQLInstanceHTTP,
  scaleCloudSQLInstancePubSub: scaleCloudSQLInstancePubSub,
  scaleCloudSQLInstanceJSON: scaleCloudSQLInstanceJSON,
  scaleCloudSQLInstanceLocal: scaleCloudSQLInstanceLocal,
};
