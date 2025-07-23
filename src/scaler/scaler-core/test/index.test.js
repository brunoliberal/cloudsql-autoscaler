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
const sinon = require("sinon");
// @ts-ignore
const referee = require("@sinonjs/referee");
// @ts-ignore
const assert = referee.assert;
const {
  createCloudSQLParameters: createCloudSQLParameters,
  createStubState,
  createStateData,
} = require("./test-utils.js");
const { afterEach } = require("mocha");

/**
 * @typedef {import('../../../autoscaler-common/types').AutoscalerCloudSQL
 * } AutoscalerCloudSQL
 * @typedef {import('../state.js').StateData} StateData
 * @typedef {import('../state.js')} State
 * @typedef {import('../index.js').LroInfo} LroInfo
 */

afterEach(() => {
  // Restore the default sandbox here
  sinon.reset();
  sinon.restore();
});

describe("#getScalingMethod", () => {
  const app = rewire("../index.js");
  const getScalingMethod = app.__get__("getScalingMethod");

  it("should return the configured scaling method function", async function () {
    const cloudsql = createCloudSQLParameters();
    cloudsql.scalingMethod = "DIRECT";
    const scalingFunction = getScalingMethod(cloudsql);
    assert.isFunction(scalingFunction.calculateSize);
    assert.equals(cloudsql.scalingMethod, "DIRECT");
  });

  it("should default to FIXED scaling", async function () {
    const cloudsql = createCloudSQLParameters();
    cloudsql.scalingMethod = "UNKNOWN_SCALING_METHOD";
    const scalingFunction = getScalingMethod(cloudsql);
    assert.isFunction(scalingFunction.calculateSize);
    assert.equals(cloudsql.scalingMethod, "FIXED");
  });
});

describe("#processScalingRequest", () => {
  const app = rewire("../index.js");

  const processScalingRequest = app.__get__("processScalingRequest");

  const countersStub = {
    incScalingSuccessCounter: sinon.stub(),
    incScalingFailedCounter: sinon.stub(),
    incScalingDeniedCounter: sinon.stub(),
    recordScalingDuration: sinon.stub(),
  };
  const stubScaleCloudSQLInstance = sinon.stub();
  const getSuggestedSizeStub = sinon.stub();
  const withinCooldownPeriod = sinon.stub();
  const readStateCheckOngoingLRO = sinon.stub();

  beforeEach(() => {
    // Setup common stubs
    stubScaleCloudSQLInstance.resolves();
    app.__set__("scaleCloudSQLInstance", stubScaleCloudSQLInstance);
    app.__set__("Counters", countersStub);
    app.__set__("withinCooldownPeriod", withinCooldownPeriod.returns(false));
    app.__set__("getSuggestedSize", getSuggestedSizeStub);
    app.__set__("readStateCheckOngoingLRO", readStateCheckOngoingLRO);

    readStateCheckOngoingLRO.returns(
      /** @type {StateData} */ (createStateData()),
    );
  });

  afterEach(() => {
    // reset stubs
    Object.values(countersStub).forEach((stub) => stub.reset());
    stubScaleCloudSQLInstance.reset();
    getSuggestedSizeStub.reset();
    withinCooldownPeriod.reset();
  });

  it("should not autoscale if suggested size is equal to current size", async function () {
    const cloudsql = createCloudSQLParameters();
    getSuggestedSizeStub.returns(cloudsql.currentSize);

    await processScalingRequest(cloudsql, createStubState());

    assert.equals(stubScaleCloudSQLInstance.callCount, 0);

    assert.equals(countersStub.incScalingSuccessCounter.callCount, 0);
    assert.equals(countersStub.incScalingDeniedCounter.callCount, 1);
    assert.equals(
      countersStub.incScalingDeniedCounter.getCall(0).args[1],
      cloudsql.currentSize,
    );
    assert.equals(
      countersStub.incScalingDeniedCounter.getCall(0).args[2],
      "CURRENT_SIZE",
    );
    assert.equals(countersStub.incScalingFailedCounter.callCount, 0);
  });

  it("should not autoscale if suggested size is equal to max size", async function () {
    const cloudsql = createCloudSQLParameters();
    cloudsql.currentSize = cloudsql.maxSize;
    getSuggestedSizeStub.returns(cloudsql.maxSize);

    await processScalingRequest(cloudsql, createStubState());

    assert.equals(stubScaleCloudSQLInstance.callCount, 0);

    assert.equals(countersStub.incScalingSuccessCounter.callCount, 0);
    assert.equals(countersStub.incScalingDeniedCounter.callCount, 1);
    assert.equals(
      countersStub.incScalingDeniedCounter.getCall(0).args[1],
      cloudsql.maxSize,
    );
    assert.equals(
      countersStub.incScalingDeniedCounter.getCall(0).args[2],
      "MAX_SIZE",
    );
    assert.equals(countersStub.incScalingFailedCounter.callCount, 0);
  });

  it("should autoscale if suggested size is not equal to current size", async function () {
    const cloudsql = createCloudSQLParameters();
    const suggestedSize = cloudsql.currentSize + 1;
    getSuggestedSizeStub.returns(suggestedSize);
    stubScaleCloudSQLInstance.returns("scalingOperationId");
    const stateStub = createStubState();

    await processScalingRequest(cloudsql, stateStub);

    assert.equals(stubScaleCloudSQLInstance.callCount, 1);
    assert.equals(stubScaleCloudSQLInstance.getCall(0).args[1], suggestedSize);
    assert.equals(countersStub.incScalingSuccessCounter.callCount, 0);
    assert.equals(countersStub.incScalingDeniedCounter.callCount, 0);
    assert.equals(countersStub.incScalingFailedCounter.callCount, 0);

    sinon.assert.calledWith(stateStub.updateState, {
      lastScalingTimestamp: stateStub.now,
      createdOn: 0,
      updatedOn: 0,
      lastScalingCompleteTimestamp: null,
      scalingOperationId: "scalingOperationId",
      scalingMethod: cloudsql.scalingMethod,
      scalingPreviousSize: cloudsql.currentSize,
      scalingRequestedSize: suggestedSize,
    });
  });

  it("should not autoscale if in cooldown period", async function () {
    const cloudsql = createCloudSQLParameters();
    const suggestedSize = cloudsql.currentSize + 100;
    getSuggestedSizeStub.returns(suggestedSize);
    withinCooldownPeriod.returns(true);

    await processScalingRequest(cloudsql, createStubState());

    assert.equals(stubScaleCloudSQLInstance.callCount, 0);
    assert.equals(countersStub.incScalingSuccessCounter.callCount, 0);
    assert.equals(countersStub.incScalingDeniedCounter.callCount, 1);
    assert.equals(
      countersStub.incScalingDeniedCounter.getCall(0).args[1],
      suggestedSize,
    );
    assert.equals(
      countersStub.incScalingDeniedCounter.getCall(0).args[2],
      "WITHIN_COOLDOWN",
    );
    assert.equals(countersStub.incScalingFailedCounter.callCount, 0);
  });

  it("should not autoscale if scalingOperationId is set", async () => {
    // set operation ongoing...
    const stubState = createStubState();
    readStateCheckOngoingLRO.returns(
      /** @type {StateData} */ ({
        lastScalingTimestamp: stubState.now,
        createdOn: 0,
        updatedOn: 0,
        lastScalingCompleteTimestamp: 0,
        scalingOperationId: "DummyOpID",
        scalingMethod: "FIXED",
        scalingPreviousSize: 100,
        scalingRequestedSize: 200,
      }),
    );

    const cloudsql = createCloudSQLParameters();
    const suggestedSize = cloudsql.currentSize + 100;
    getSuggestedSizeStub.returns(suggestedSize);

    await processScalingRequest(cloudsql, stubState);

    assert.equals(stubScaleCloudSQLInstance.callCount, 0);
    assert.equals(countersStub.incScalingSuccessCounter.callCount, 0);
    assert.equals(countersStub.incScalingDeniedCounter.callCount, 1);
    assert.equals(
      countersStub.incScalingDeniedCounter.getCall(0).args[1],
      cloudsql.currentSize + 100,
    );
    assert.equals(
      countersStub.incScalingDeniedCounter.getCall(0).args[2],
      "IN_PROGRESS",
    );
    assert.equals(countersStub.incScalingFailedCounter.callCount, 0);
  });

  it("Scaling failures increment counter", async function () {
    const cloudsql = createCloudSQLParameters();
    const suggestedSize = cloudsql.currentSize + 100;
    getSuggestedSizeStub.returns(suggestedSize);
    stubScaleCloudSQLInstance.rejects("Error");

    await processScalingRequest(cloudsql, createStubState());

    assert.equals(stubScaleCloudSQLInstance.callCount, 1);
    assert.equals(stubScaleCloudSQLInstance.getCall(0).args[1], suggestedSize);
    assert.equals(countersStub.incScalingSuccessCounter.callCount, 0);
    assert.equals(countersStub.incScalingDeniedCounter.callCount, 0);
    assert.equals(countersStub.incScalingFailedCounter.callCount, 1);
    assert.equals(
      countersStub.incScalingFailedCounter.getCall(0).args[1],
      cloudsql.scalingMethod,
    );
    assert.equals(
      countersStub.incScalingFailedCounter.getCall(0).args[2],
      cloudsql.currentSize,
    );
    assert.equals(
      countersStub.incScalingFailedCounter.getCall(0).args[3],
      cloudsql.currentSize + 100,
    );
  });
});

describe("#withinCooldownPeriod", () => {
  const app = rewire("../index.js");
  const withinCooldownPeriod = app.__get__("withinCooldownPeriod");

  /** @type {StateData} */
  let autoscalerState;
  /** @type {AutoscalerCloudSQL} */
  let cloudsqlParams;

  const lastScalingTime = Date.parse("2024-01-01T12:00:00Z");
  const MILLIS_PER_MINUTE = 60_000;

  beforeEach(() => {
    cloudsqlParams = createCloudSQLParameters();

    autoscalerState = {
      lastScalingCompleteTimestamp: lastScalingTime,
      scalingOperationId: null,
      lastScalingTimestamp: lastScalingTime,
      createdOn: 0,
      updatedOn: 0,
      scalingPreviousSize: null,
      scalingRequestedSize: null,
      scalingMethod: null,
    };
  });

  it("should be false when no scaling has ever happened", () => {
    autoscalerState.lastScalingCompleteTimestamp = 0;
    autoscalerState.lastScalingTimestamp = 0;

    assert.isFalse(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize + 100,
        autoscalerState,
        lastScalingTime,
      ),
    );
  });

  it("should be false when scaling up later than cooldown", () => {
    // test at 1 min after end of cooldown...
    const testTime =
      lastScalingTime +
      (cloudsqlParams.scaleOutCoolingMinutes + 1) * MILLIS_PER_MINUTE;

    assert.isFalse(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize + 100,
        autoscalerState,
        testTime,
      ),
    );
  });

  it("should be false when scaling down later than cooldown", () => {
    // test at 1 min before end of cooldown...
    const testTime =
      lastScalingTime +
      (cloudsqlParams.scaleInCoolingMinutes + 1) * MILLIS_PER_MINUTE;

    assert.isFalse(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize - 100,
        autoscalerState,
        testTime,
      ),
    );
  });

  it("should be false when overloaded after overloadCoolingMinutes", () => {
    cloudsqlParams.isOverloaded = true;
    cloudsqlParams.overloadCoolingMinutes = 30;
    // test at 1 min after end of cooldown...
    const testTime =
      lastScalingTime +
      (cloudsqlParams.overloadCoolingMinutes + 1) * MILLIS_PER_MINUTE;

    assert.isFalse(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize + 100,
        autoscalerState,
        testTime,
      ),
    );
  });

  it("should be true when overloaded and within overloadCoolingMinutes", () => {
    cloudsqlParams.isOverloaded = true;
    cloudsqlParams.overloadCoolingMinutes = 30;

    // test at 29 mins later...
    assert.isTrue(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize + 100,
        autoscalerState,
        lastScalingTime + 29 * 60 * 1_000,
      ),
    );
  });

  it("should be true when scaling up within scaleOutCoolingMinutes", () => {
    // test at 1 min before end of cooldown...
    const testTime =
      lastScalingTime +
      (cloudsqlParams.scaleOutCoolingMinutes - 1) * MILLIS_PER_MINUTE;

    assert.isTrue(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize + 100,
        autoscalerState,
        testTime,
      ),
    );
  });

  it("should be true when scaling down within scaleInCoolingMinutes", () => {
    // test at 1 min before end of cooldown...
    const testTime =
      lastScalingTime +
      (cloudsqlParams.scaleInCoolingMinutes - 1) * MILLIS_PER_MINUTE;

    assert.isTrue(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize - 100,
        autoscalerState,
        testTime,
      ),
    );
  });

  it("should use lastScalingCompleteTimestamp when specified", () => {
    autoscalerState.lastScalingTimestamp = 0;

    assert.isTrue(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize - 100,
        autoscalerState,
        lastScalingTime,
      ),
    );
  });

  it("should use lastScalingTimestamp if complete not specified", () => {
    autoscalerState.lastScalingCompleteTimestamp = 0;

    assert.isTrue(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize - 100,
        autoscalerState,
        lastScalingTime,
      ),
    );
  });

  it("should be true when another scaling down within 3h", () => {
    autoscalerState.scalingPreviousSize = 4;
    autoscalerState.scalingRequestedSize = 2;

    assert.isTrue(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize - 1, // scale-down
        autoscalerState,
        lastScalingTime + 120 * MILLIS_PER_MINUTE, // test at 2h before end of cooldown...,
      ),
    );
  });

  it("should be false when another scaling down after 3h", () => {
    autoscalerState.scalingPreviousSize = 4;
    autoscalerState.scalingRequestedSize = 2;

    assert.isFalse(
      withinCooldownPeriod(
        cloudsqlParams,
        cloudsqlParams.currentSize - 1, // scale-down
        autoscalerState,
        lastScalingTime + 180 * MILLIS_PER_MINUTE, // test at 3h before end of cooldown...
      ),
    );
  });
});

describe("#readStateCheckOngoingLRO", () => {
  const app = rewire("../index.js");
  const readStateCheckOngoingLRO = app.__get__("readStateCheckOngoingLRO");

  const countersStub = {
    incScalingFailedCounter: sinon.stub(),
    incScalingSuccessCounter: sinon.stub(),
    recordScalingDuration: sinon.stub(),
  };

  /** @type {StateData} */
  let autoscalerState;
  /** @type {StateData} */
  let originalAutoscalerState;
  /** @type {AutoscalerCloudSQL} */
  let cloudsqlParams;
  /** @type {sinon.SinonStubbedInstance<State>} */
  let stateStub;
  /** @type {*} */
  let operation;

  const getOperation = sinon.stub();
  const fakeCloudSQLAPI = {
    operations: {
      get: getOperation,
    },
  };
  app.__set__("cloudSQLRestApi", fakeCloudSQLAPI);
  app.__set__("Counters", countersStub);

  const lastScalingDate = new Date("2024-01-01T12:00:00Z");

  beforeEach(() => {
    cloudsqlParams = createCloudSQLParameters();
    stateStub = createStubState();

    // A State with an ongoing operation
    autoscalerState = {
      lastScalingCompleteTimestamp: 0,
      scalingOperationId: "OperationId",
      lastScalingTimestamp: lastScalingDate.getTime(),
      createdOn: 0,
      updatedOn: 0,
      scalingPreviousSize: 1,
      scalingRequestedSize: 2,
      scalingMethod: "FIXED",
    };
    originalAutoscalerState = { ...autoscalerState };

    operation = {
      operationType: "UPDATE",
      done: null,
      error: null,
      endTime: null,
      startTime: lastScalingDate.toISOString(),
    };
  });

  afterEach(() => {
    getOperation.reset();
    Object.values(countersStub).forEach((stub) => stub.reset());
  });

  it("should no-op when no LRO ID in state", async () => {
    autoscalerState.scalingOperationId = null;

    stateStub.get.resolves(autoscalerState);
    const expectedState = {
      ...originalAutoscalerState,
      scalingOperationId: null,
    };

    assert.equals(
      await readStateCheckOngoingLRO(cloudsqlParams, stateStub),
      /** @type {StateData} */ (expectedState),
    );
    sinon.assert.notCalled(getOperation);
    sinon.assert.notCalled(countersStub.incScalingSuccessCounter);
    sinon.assert.notCalled(countersStub.recordScalingDuration);
    sinon.assert.notCalled(stateStub.updateState);
  });

  it("should clear the operation if operation.get fails", async () => {
    stateStub.get.resolves(autoscalerState);
    getOperation.rejects(new Error("operation.get() error"));

    const expectedState = {
      ...originalAutoscalerState,
      scalingOperationId: null,
      lastScalingCompleteTimestamp: lastScalingDate.getTime(),
      scalingMethod: null,
      scalingPreviousSize: null,
      scalingRequestedSize: null,
    };
    assert.equals(
      await readStateCheckOngoingLRO(cloudsqlParams, stateStub),
      /** @type {StateData} */ (expectedState),
    );

    sinon.assert.calledOnce(getOperation);
    // Failure to get the operation is considered a 'success'...
    sinon.assert.calledOnceWithMatch(
      countersStub.incScalingSuccessCounter,
      sinon.match.any, // cloudsql
      sinon.match("FIXED"),
      sinon.match(1),
      sinon.match(2),
    );
    sinon.assert.calledOnceWithMatch(
      countersStub.recordScalingDuration,
      sinon.match(0), // duration
      sinon.match.any, // cloudsql
      sinon.match("FIXED"),
      sinon.match(1),
      sinon.match(2),
    );
    sinon.assert.calledWith(stateStub.updateState, expectedState);
  });

  it("should clear the operation if operation.get returns null", async () => {
    stateStub.get.resolves(autoscalerState);
    getOperation.resolves({ data: null });

    const expectedState = {
      ...originalAutoscalerState,
      scalingOperationId: null,
      lastScalingCompleteTimestamp: lastScalingDate.getTime(),
      scalingMethod: null,
      scalingPreviousSize: null,
      scalingRequestedSize: null,
    };
    assert.equals(
      await readStateCheckOngoingLRO(cloudsqlParams, stateStub),
      /** @type {StateData} */ (expectedState),
    );

    sinon.assert.calledOnce(getOperation);
    // Failure to get the operation is considered a 'success'...
    // Failure to get the operation is considered a 'success'...
    sinon.assert.calledOnceWithMatch(
      countersStub.incScalingSuccessCounter,
      sinon.match.any, // cloudsql
      sinon.match("FIXED"),
      sinon.match(1),
      sinon.match(2),
    );
    sinon.assert.calledOnceWithMatch(
      countersStub.recordScalingDuration,
      sinon.match(0), // duration
      sinon.match.any, // cloudsql
      sinon.match("FIXED"),
      sinon.match(1),
      sinon.match(2),
    );
    sinon.assert.calledWith(stateStub.updateState, expectedState);
  });

  it("should clear lastScaling and increment counter if op failed with error", async () => {
    stateStub.get.resolves(autoscalerState);
    operation.status = "DONE";
    operation.error = { errors: [{ message: "Scaling op failed" }] };
    operation.endTime = // 60 seconds after start
      new Date(lastScalingDate.getTime() + 60_000).toISOString();
    getOperation.resolves({ data: operation });

    const expectedState = {
      ...originalAutoscalerState,
      scalingOperationId: null,
      lastScalingCompleteTimestamp: 0,
      lastScalingTimestamp: 0,
      scalingMethod: null,
      scalingPreviousSize: null,
      scalingRequestedSize: null,
    };
    assert.equals(
      await readStateCheckOngoingLRO(cloudsqlParams, stateStub),
      /** @type {StateData} */ (expectedState),
    );

    sinon.assert.calledOnce(getOperation);
    sinon.assert.notCalled(countersStub.incScalingSuccessCounter);
    sinon.assert.notCalled(countersStub.recordScalingDuration);
    sinon.assert.calledOnceWithMatch(
      countersStub.incScalingFailedCounter,
      sinon.match.any, // cloudsql
      sinon.match("FIXED"),
      sinon.match(1),
      sinon.match(2),
    );
    sinon.assert.calledWith(stateStub.updateState, expectedState);
  });

  it("should leave state unchanged if op not done yet", async () => {
    stateStub.get.resolves(autoscalerState);
    operation.status = "RUNNING";
    getOperation.resolves({ data: operation });

    assert.equals(
      await readStateCheckOngoingLRO(cloudsqlParams, stateStub),
      /** @type {StateData} */ (originalAutoscalerState),
    );

    sinon.assert.calledOnce(getOperation);
    sinon.assert.notCalled(countersStub.incScalingSuccessCounter);
    sinon.assert.notCalled(countersStub.recordScalingDuration);
    sinon.assert.calledWith(stateStub.updateState, originalAutoscalerState);
  });

  it("should update timestamp, record metrics and clear ID when completed", async () => {
    stateStub.get.resolves(autoscalerState);
    // 60 seconds after start
    const endTime = lastScalingDate.getTime() + 60_000;
    operation.status = "DONE";
    operation.endTime = new Date(endTime).toISOString();
    getOperation.resolves({ data: operation });

    const expectedState = {
      ...originalAutoscalerState,
      scalingOperationId: null,
      lastScalingCompleteTimestamp: endTime,
      scalingMethod: null,
      scalingPreviousSize: null,
      scalingRequestedSize: null,
    };
    assert.equals(
      await readStateCheckOngoingLRO(cloudsqlParams, stateStub),
      /** @type {StateData} */ (expectedState),
    );

    sinon.assert.calledOnce(getOperation);

    sinon.assert.calledOnceWithMatch(
      countersStub.incScalingSuccessCounter,
      sinon.match.any, // cloudsql
      sinon.match("FIXED"),
      sinon.match(1),
      sinon.match(2),
    );
    sinon.assert.calledOnceWithMatch(
      countersStub.recordScalingDuration,
      sinon.match(60_000), // duration
      sinon.match.any, // cloudsql
      sinon.match("FIXED"),
      sinon.match(1),
      sinon.match(2),
    );
    sinon.assert.calledWith(stateStub.updateState, expectedState);
  });

  it("with noSavedStateScalingInfo should update timestamp, record metrics and clear ID when completed", async () => {
    stateStub.get.resolves({
      ...autoscalerState,
      scalingMethod: null,
      scalingPreviousSize: null,
      scalingRequestedSize: null,
    });
    // 60 seconds after start
    const endTime = lastScalingDate.getTime() + 60_000;
    operation.status = "DONE";
    operation.endTime = new Date(endTime).toISOString();
    getOperation.resolves({ data: operation });

    const expectedState = {
      ...originalAutoscalerState,
      scalingOperationId: null,
      lastScalingCompleteTimestamp: endTime,
      scalingMethod: null,
      scalingPreviousSize: null,
      scalingRequestedSize: null,
    };
    assert.equals(
      await readStateCheckOngoingLRO(cloudsqlParams, stateStub),
      /** @type {StateData} */ (expectedState),
    );

    sinon.assert.calledOnce(getOperation);

    sinon.assert.calledOnceWithMatch(
      countersStub.incScalingSuccessCounter,
      sinon.match.any, // cloudsql
      null,
      null,
      sinon.match(100),
    );
    sinon.assert.calledOnceWithMatch(
      countersStub.recordScalingDuration,
      sinon.match(60_000), // duration
      sinon.match.any, // cloudsql
      null,
      null,
      sinon.match(100),
    );
    sinon.assert.calledWith(stateStub.updateState, expectedState);
  });
});
