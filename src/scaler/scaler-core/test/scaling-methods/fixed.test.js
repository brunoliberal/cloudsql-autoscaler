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
const rewire = require("rewire");
require("should");
const sinon = require("sinon");
// @ts-ignore
const referee = require("@sinonjs/referee");
// @ts-ignore
const assert = referee.assert;
const { createCloudSQLParameters } = require("../test-utils.js");
const { AVAILABLE_VCPUS } = require("../../scaling-methods/fixed.js");
const {
  OVERLOAD_METRIC,
  OVERLOAD_THRESHOLD,
} = require("../../scaling-methods/base.js");

const app = rewire("../../scaling-methods/fixed.js");

afterEach(() => {
  // Restore the default sandbox here
  sinon.restore();
});

/**
 * create base stub
 * @param {Object} cloudsql
 * @param {Object} metric
 * @param {boolean} metricValueWithinRange
 * @return {sinon.SinonStub} base module
 */
function stubBaseModule(cloudsql, metric, metricValueWithinRange) {
  const callbackStub = sinon.stub().callsArgWith(1, cloudsql, metric);
  app.__set__("baseModule.loopThroughCloudSQLMetrics", callbackStub);
  app.__set__(
    "baseModule.metricValueWithinRange",
    sinon.stub().returns(metricValueWithinRange),
  );
  return callbackStub;
}

const calculateSize = app.__get__("calculateSize");
describe("#fixed.calculateSize", () => {
  it("should return current size if the metric is within range", () => {
    const cloudsql = createCloudSQLParameters({ currentSize: 2 });
    const callbackStub = stubBaseModule(cloudsql, {}, true);

    calculateSize(cloudsql).should.equal(2);
    assert.equals(callbackStub.callCount, 1);
  });

  it("should move available vCPU list UP if the metric is ABOVE range", () => {
    const currVcpuIdx = 1;
    const cloudsql = createCloudSQLParameters({
      currentSize: AVAILABLE_VCPUS[currVcpuIdx],
    });
    const callbackStub = stubBaseModule(
      cloudsql,
      { value: 85, threshold: 65, margin: 5 },
      false,
    );

    calculateSize(cloudsql).should.equal(AVAILABLE_VCPUS[currVcpuIdx + 1]);
    assert.equals(callbackStub.callCount, 1);
  });

  it("should not move vCPU UP available limit if the metric is ABOVE range", () => {
    const currVcpuIdx = AVAILABLE_VCPUS.length - 1;
    const cloudsql = createCloudSQLParameters({
      currentSize: AVAILABLE_VCPUS[currVcpuIdx],
    });
    const callbackStub = stubBaseModule(
      cloudsql,
      { value: 85, threshold: 65, margin: 5 },
      false,
    );

    calculateSize(cloudsql).should.equal(AVAILABLE_VCPUS[currVcpuIdx]);
    assert.equals(callbackStub.callCount, 1);
  });

  it("should not move vCPU DOWN available limit if the metric is BELOW range", () => {
    const currVcpuIdx = 0;
    const cloudsql = createCloudSQLParameters({
      currentSize: AVAILABLE_VCPUS[currVcpuIdx],
    });
    const callbackStub = stubBaseModule(
      cloudsql,
      { value: 15, threshold: 65 },
      false,
    );

    calculateSize(cloudsql).should.equal(AVAILABLE_VCPUS[currVcpuIdx]);
    assert.equals(callbackStub.callCount, 1);
  });

  it("should move available vCPU list DOWN if the metric is BELOW range", () => {
    const currVcpuIdx = 3;
    const cloudsql = createCloudSQLParameters({
      currentSize: AVAILABLE_VCPUS[currVcpuIdx],
    });
    const callbackStub = stubBaseModule(
      cloudsql,
      { value: 15, threshold: 65 },
      false,
    );

    calculateSize(cloudsql).should.equal(AVAILABLE_VCPUS[currVcpuIdx - 1]);
    assert.equals(callbackStub.callCount, 1);
  });

  it("should jump the available vCPUs by overloadStepSize if the instance is overloaded", () => {
    const currVcpuIdx = 1;
    const overloadStepSize = 2;
    const cloudsql = createCloudSQLParameters({
      currentSize: AVAILABLE_VCPUS[currVcpuIdx],
      overloadStepSize: overloadStepSize,
      isOverloaded: true,
    });
    const callbackStub = stubBaseModule(
      cloudsql,
      {
        name: OVERLOAD_METRIC,
        value: OVERLOAD_THRESHOLD + 1,
        threshold: 65,
      },
      false,
    );

    calculateSize(cloudsql).should.equal(
      AVAILABLE_VCPUS[currVcpuIdx + overloadStepSize + 1],
    );
    assert.equals(callbackStub.callCount, 1);
  });
});
