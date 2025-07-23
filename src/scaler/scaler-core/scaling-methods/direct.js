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
 * Direct scaling method
 *
 * Suggests scaling to the number of nodes or processing units specified by
 * maxSize. Useful to scale an instance in preparation for a batch job, and to
 * scale it back after the job is finished.
 */
const { logger } = require("../../../autoscaler-common/logger");

/**
 * @typedef {import('../../../autoscaler-common/types').AutoscalerCloudSQL
 * } AutoscalerCloudSQL
 */

/**
 * Size calculation for Direct scaling method
 * @param {AutoscalerCloudSQL} cloudsql
 * @return {number}
 */
function calculateSize(cloudsql) {
  logger.debug({
    message: `---- DIRECT size suggestions for ${cloudsql.projectId}/${cloudsql.instanceId}----`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
  });
  logger.debug({
    message: `\tFinal DIRECT suggestion: ${cloudsql.maxSize} + ${cloudsql.units}}`,
    projectId: cloudsql.projectId,
    instanceId: cloudsql.instanceId,
  });
  return cloudsql.maxSize;
}

module.exports = { calculateSize };
