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
 * Fixed scaling method
 *
 * Default method used by the scaler.
 * Suggests changing machine type using a fixed list of values.
 */
const baseModule = require("./base.js");
const { logger } = require("../../../autoscaler-common/logger.js");

/**
 * @typedef {import('../../../autoscaler-common/types.js').AutoscalerCloudSQL
 * } AutoscalerCloudSQL
 */

/*
 * CloudSQL availabile machine types for enterprise plus edition
 * db-perf-optimized-N-X where X is the number of vCPUs
 * listed on https://cloud.google.com/sql/docs/mysql/instance-settings
 */
const AVAILABLE_VCPUS = [2, 4, 8, 16, 32, 48, 64, 80, 96, 128];

/**
 * Scaling calculation for Fixed method
 *
 * @param {AutoscalerCloudSQL} cloudsql
 * @return {number}
 */
function calculateSize(cloudsql) {
  return baseModule.loopThroughCloudSQLMetrics(cloudsql, (cloudsql, metric) => {
    if (baseModule.metricValueWithinRange(metric)) {
      return cloudsql.currentSize;
    } // No change

    const currentVcpuIdx = AVAILABLE_VCPUS.indexOf(
      parseInt(cloudsql.currentSize),
    );

    if (metric.name === baseModule.OVERLOAD_METRIC && cloudsql.isOverloaded) {
      logger.debug({
        message: `\t Metric ${metric.name} overloaded. Using overloadStepSize: ${cloudsql.overloadStepSize}`,
        projectId: cloudsql.projectId,
        instanceId: cloudsql.instanceId,
      });
      return AVAILABLE_VCPUS[
        Math.min(
          currentVcpuIdx + cloudsql.overloadStepSize + 1,
          AVAILABLE_VCPUS.length - 1,
        )
      ];
    } // Overloaded

    // Scale up or down by moving up or down through the available vCPUs list
    const suggestedSize =
      AVAILABLE_VCPUS[
        metric.value > metric.threshold + metric.margin
          ? Math.min(currentVcpuIdx + 1, AVAILABLE_VCPUS.length - 1) // Next or Max
          : Math.max(currentVcpuIdx - 1, 0)
      ]; // Previous or Min

    return suggestedSize;
  });
}

module.exports = { AVAILABLE_VCPUS, calculateSize };
