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
 * Base module that encapsulates functionality common to scaling methods:
 * * Loop through the CloudSQL metrics
 * * Determine if the CloudSQL instance is overloaded
 * * Log sizing suggestions per metric
 */

// Only the cpu metric is used to determine if an overload situation exists
const OVERLOAD_METRIC = "cpu";
const OVERLOAD_THRESHOLD = 90;

/** @enum {string} */
const RelativeToRange = {
  BELOW: "BELOW",
  WITHIN: "WITHIN",
  ABOVE: "ABOVE",
};

// Autoscaling is triggered if the metric value is outside of threshold +-
// margin
const DEFAULT_THRESHOLD_MARGIN = 5;

// TODO: for recommendation of databases per vCPU
// Min 10 databases per VCPU.
// const DATABASES_PER_VCPU = 10;

const { logger } = require("../../../autoscaler-common/logger");
// const { AutoscalerUnits } = require("../../../autoscaler-common/types");

/**
 * @typedef {import('../../../autoscaler-common/types').AutoscalerCloudSQL
 * } AutoscalerCloudSQL
 * @typedef {import('../../../autoscaler-common/types').CloudSQLMetricValue
 * } CloudSQLMetricValue
 */

/**
 * Get a string describing the scaling suggestion.
 *
 * @param {AutoscalerCloudSQL} cloudsql
 * @param {number} suggestedSize
 * @param {string} relativeToRange
 * @return {string}
 */
function getScaleSuggestionMessage(cloudsql, suggestedSize, relativeToRange) {
  if (relativeToRange == RelativeToRange.WITHIN) {
    return `no change suggested`;
  }
  if (suggestedSize > cloudsql.maxSize) {
    return `however, cannot scale to ${suggestedSize} because it is higher than MAX ${cloudsql.maxSize} ${cloudsql.units}`;
  }
  if (suggestedSize < cloudsql.minSize) {
    return `however, cannot scale to ${suggestedSize} because it is lower than MIN ${cloudsql.minSize} ${cloudsql.units}`;
  }
  if (suggestedSize == cloudsql.currentSize) {
    return `the suggested size is equal to the current size: ${cloudsql.currentSize} ${cloudsql.units}`;
  }
  return `suggesting to scale from ${cloudsql.currentSize} to ${suggestedSize} ${cloudsql.units}.`;
}

/**
 * Build a ranger object from given threshold and margin.
 * @param {number} threshold
 * @param {number} margin
 * @return {{min: number,max: number}}
 */
function getRange(threshold, margin) {
  const range = { min: threshold - margin, max: threshold + margin };

  if (range.min < 0) range.min = 0;
  if (range.max > 100) range.max = 100;

  return range;
}

/**
 * Test if given metric is within a range
 * @param {CloudSQLMetricValue} metric
 * @return {boolean}
 */
function metricValueWithinRange(metric) {
  if (compareMetricValueWithRange(metric) == RelativeToRange.WITHIN) {
    return true;
  } else {
    return false;
  }
}

/**
 * Test to see where a metric fits within its range
 *
 * @param {CloudSQLMetricValue} metric
 * @return {RelativeToRange} RelativeToRange enum
 */
function compareMetricValueWithRange(metric) {
  const range = getRange(metric.threshold, metric.margin);

  if (metric.value < range.min) return RelativeToRange.BELOW;
  if (metric.value > range.max) return RelativeToRange.ABOVE;
  return RelativeToRange.WITHIN;
}

/**
 * Log the suggested scaling.
 * @param {AutoscalerCloudSQL} cloudsql
 * @param {CloudSQLMetricValue} metric
 * @param {number} suggestedSize
 */
function logSuggestion(cloudsql, metric, suggestedSize) {
  const metricDetails = `\t${metric.name}=${metric.value}%,`;
  const relativeToRange = compareMetricValueWithRange(metric);

  const range = getRange(metric.threshold, metric.margin);
  const rangeDetails = `${relativeToRange} the range [${range.min}%-${range.max}%]`;

  if (metric.name === OVERLOAD_METRIC && cloudsql.isOverloaded) {
    logger.debug({
      message: `${metricDetails} ABOVE the ${OVERLOAD_THRESHOLD} overload threshold => ${getScaleSuggestionMessage(
        cloudsql,
        suggestedSize,
        RelativeToRange.ABOVE,
      )}`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
    });
  } else {
    logger.debug({
      message: `${metricDetails} ${rangeDetails} => ${getScaleSuggestionMessage(
        cloudsql,
        suggestedSize,
        relativeToRange,
      )}`,
      projectId: cloudsql.projectId,
      instanceId: cloudsql.instanceId,
    });
  }
}

/**
 * Get the max suggested size for the given cloudsql instance based
 * on its metrics
 *
 * @param {AutoscalerCloudSQL} cloudsql
 * @param {function(AutoscalerCloudSQL,CloudSQLMetricValue): number
 * } getSuggestedSize
 * @return {number}
 */
function loopThroughCloudSQLMetrics(cloudsql, getSuggestedSize) {
  logger.debug({
    message: `---- ${cloudsql.projectId}/${cloudsql.instanceId}: ${cloudsql.scalingMethod} size suggestions----`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
  });
  logger.debug({
    message: `\tMin=${cloudsql.minSize}, Current=${cloudsql.currentSize}, Max=${cloudsql.maxSize} ${cloudsql.units}`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
  });

  let maxSuggestedSize = cloudsql.minSize;

  // TODO: for recommendation for numDatabases per vCPU
  // if (
  //   cloudsql.units === AutoscalerUnits.VCPU &&
  //   cloudsql.currentNumDatabases
  // ) {
  //   const minVcpuForNumDatabases =
  //     Math.ceil(cloudsql.currentNumDatabases / DATABASES_PER_VCPU);
  //   logger.info({
  //     message: `\tMinumum ${minVcpuForNumDatabases} ${cloudsql.units} required for ${cloudsql.currentNumDatabases} databases`,
  //     projectId: cloudsql.projectId,
  //     instanceId: cloudsql.instanceId,
  //   });
  //   maxSuggestedSize = Math.max(maxSuggestedSize, minVcpuForNumDatabases);
  // }

  cloudsql.isOverloaded = false;

  for (const metric of /** @type {CloudSQLMetricValue[]} */ (
    cloudsql.metrics
  )) {
    if (metric.name === OVERLOAD_METRIC && metric.value > OVERLOAD_THRESHOLD) {
      cloudsql.isOverloaded = true;
    }

    if (!metric.hasOwnProperty("margin")) {
      metric.margin = DEFAULT_THRESHOLD_MARGIN;
    }

    const suggestedSize = getSuggestedSize(cloudsql, metric);
    logSuggestion(cloudsql, metric, suggestedSize);

    maxSuggestedSize = Math.max(maxSuggestedSize, suggestedSize);
  }

  maxSuggestedSize = Math.min(maxSuggestedSize, cloudsql.maxSize);
  logger.debug({
    message: `\t=> Final ${cloudsql.scalingMethod} suggestion: ${maxSuggestedSize} ${cloudsql.units}`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
  });
  return maxSuggestedSize;
}

module.exports = {
  OVERLOAD_METRIC,
  OVERLOAD_THRESHOLD,
  loopThroughCloudSQLMetrics,
  metricValueWithinRange,
};
