/**
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
 * limitations under the License.
 */

/*
 * Manages the Autoscaler persistent state
 *
 * By default, this implementation uses a Firestore instance in the same
 * project as the CloudSQL instance. To use a different project, set the
 * `stateProjectId` parameter in the Cloud Scheduler configuration.
 *
 * To use another database to save autoscaler state, set the
 * `stateDatabase.name` parameter in the Cloud Scheduler configuration.
 * The default database is Firestore.
 */

const firestore = require("@google-cloud/firestore");
const { logger } = require("../../autoscaler-common/logger");
const assertDefined = require("../../autoscaler-common/assertDefined");
const { memoize } = require("lodash");
/**
 * @typedef {import('../../autoscaler-common/types').AutoscalerCloudSQL
 * } AutoscalerCloudSQL
 * @typedef {import('../../autoscaler-common/types').StateDatabaseConfig
 * } StateDatabaseConfig
 */

/**
 * @typedef StateData
 * @property {number?} lastScalingCompleteTimestamp - when the last scaling operation completed.
 * @property {string?} scalingOperationId - the ID of the currently in progress scaling operation.
 * @property {number?} scalingRequestedSize - the requested size of the currently in progress scaling operation.
 * @property {number?} scalingPreviousSize - the size of the cluster before the currently in progress scaling operation started.
 * @property {string?} scalingMethod - the scaling method used to calculate the size for the currently in progress scaling operation.
 * @property {number} lastScalingTimestamp - when the last scaling operation was started.
 * @property {number} createdOn - the timestamp when this record was created
 * @property {number} updatedOn - the timestamp when this record was updated.
 */

/**
 * @typedef ColumnDef
 * @property {string} name
 * @property {string} type
 * @property {boolean=} newSchemaCol a column which has been added to the schema, and if not present, will be ignored.
 */
/**
 * Column type definitions for State.
 * @type {Array<ColumnDef>}
 */
const STATE_KEY_DEFINITIONS = [
  { name: "lastScalingTimestamp", type: "timestamp" },
  { name: "createdOn", type: "timestamp" },
  { name: "updatedOn", type: "timestamp" },
  { name: "lastScalingCompleteTimestamp", type: "timestamp" },
  { name: "scalingOperationId", type: "string" },
  { name: "scalingRequestedSize", type: "number", newSchemaCol: true },
  { name: "scalingPreviousSize", type: "number", newSchemaCol: true },
  { name: "scalingMethod", type: "string", newSchemaCol: true },
];

/**
 * Used to store state of a CloudSQL instance
 */
class State {
  /**
   * Build a State object for the given configuration
   *
   * @param {AutoscalerCloudSQL} cloudsql
   * @return {State}
   */
  static buildFor(cloudsql) {
    if (!cloudsql) {
      throw new Error("cloudsql should not be null");
    }
    return new StateFirestore(cloudsql);
  }

  /**
   * @constructor
   * @protected
   * @param {AutoscalerCloudSQL} cloudsql
   */
  constructor(cloudsql) {
    /** @type {string} */
    this.stateProjectId =
      cloudsql.stateProjectId != null
        ? cloudsql.stateProjectId
        : cloudsql.projectId;
    this.projectId = cloudsql.projectId;
    this.instanceId = cloudsql.instanceId;
  }

  /**
   * Initialize value in storage
   * @return {Promise<*>}
   */
  async init() {
    throw new Error("Not implemented");
  }

  /**
   * Get scaling timestamp from storage
   *
   * @return {Promise<StateData>}
   */
  async get() {
    throw new Error("Not implemented");
  }

  /**
   * Update state data in storage with the given values
   * @param {StateData} stateData
   */
  async updateState(stateData) {
    throw new Error("Not implemented");
  }

  /**
   * Close storage
   */
  async close() {
    throw new Error("Not implemented");
  }

  /**
   * Get current timestamp in millis.
   *
   * @return {number};
   */
  get now() {
    return Date.now();
  }

  /**
   * @return {string} full ID for this CloudSQL instance
   */
  getCloudSQLId() {
    return `projects/${this.projectId}/instances/${this.instanceId}`;
    // return this.instanceId;
  }
}

module.exports = State;

/**
 * Manages the Autoscaler persistent state in firestore.
 *
 */
class StateFirestore extends State {
  /**
   * Builds a Firestore client for the given project ID
   * @param {string} stateProjectId
   * @return {firestore.Firestore}
   */
  static createFirestoreClient(stateProjectId) {
    return new firestore.Firestore({ projectId: stateProjectId });
  }

  /**
   * Memoize createFirestoreClient() so that we only create one Firestore
   * client for each stateProject
   */
  static getFirestoreClient = memoize(StateFirestore.createFirestoreClient);

  /**
   * @param {AutoscalerCloudSQL} cloudsql
   */
  constructor(cloudsql) {
    super(cloudsql);
    this.firestore = StateFirestore.getFirestoreClient(this.stateProjectId);
  }

  /**
   * build or return the document reference
   * @return {firestore.DocumentReference}
   */
  get docRef() {
    if (this._docRef == null) {
      this._docRef = this.firestore.doc(
        `cloudsqlAutoscaler/state/${this.getCloudSQLId()}`,
      );
    }
    return this._docRef;
  }

  /**
   * Converts document data from Firestore.Timestamp (implementation detail)
   * to standard JS timestamps, which are number of milliseconds since Epoch
   * https://googleapis.dev/nodejs/firestore/latest/Timestamp.html
   * @param {any} docData
   * @return {StateData} converted docData
   */
  static convertFromStorage(docData) {
    /** @type {{[x:string]: any}} */
    const ret = {};

    const docDataKeys = Object.keys(docData);

    // Copy values into row that are present and are known keys.
    for (const colDef of STATE_KEY_DEFINITIONS) {
      if (docDataKeys.includes(colDef.name)) {
        ret[colDef.name] = docData[colDef.name];
        if (docData[colDef.name] instanceof firestore.Timestamp) {
          ret[colDef.name] = docData[colDef.name].toMillis();
        }
      } else {
        // not present in doc:
        if (colDef.type === "timestamp") {
          ret[colDef.name] = 0;
        } else {
          ret[colDef.name] = null;
        }
      }
    }
    return /** @type {StateData} */ (ret);
  }

  /**
   * Convert StateData to an object only containing defined
   * columns, including converting timestamps from millis to Firestore.Timestamp
   *
   * @param {*} stateData
   * @return {*}
   */
  static convertToStorage(stateData) {
    /** @type {{[x:string]: any}} */
    const doc = {};

    const stateDataKeys = Object.keys(stateData);

    // Copy values into row that are present and are known keys.
    for (const colDef of STATE_KEY_DEFINITIONS) {
      if (stateDataKeys.includes(colDef.name)) {
        if (colDef.type === "timestamp") {
          // convert millis to Firestore timestamp
          doc[colDef.name] = firestore.Timestamp.fromMillis(
            stateData[colDef.name],
          );
        } else {
          // copy value
          doc[colDef.name] = stateData[colDef.name];
        }
      }
    }
    // we never want to update createdOn
    delete doc.createdOn;

    return doc;
  }

  /** @inheritdoc */
  async init() {
    const initData = {
      createdOn: firestore.Timestamp.fromMillis(this.now),
      updatedOn: firestore.Timestamp.fromMillis(this.now),
      lastScalingTimestamp: firestore.Timestamp.fromMillis(0),
      lastScalingCompleteTimestamp: firestore.Timestamp.fromMillis(0),
      scalingOperationId: null,
      scalingRequestedSize: null,
      scalingMethod: null,
      scalingPreviousSize: null,
    };

    await this.docRef.set(initData);
    return initData;
  }

  /** @inheritdoc */
  async get() {
    let snapshot = await this.docRef.get(); // returns QueryDocumentSnapshot

    if (!snapshot.exists) {
      // It is possible that an old state doc exists in an old docref path...
      snapshot = assertDefined(await this.checkAndReplaceOldDocRef());
    }

    let data;
    if (!snapshot?.exists) {
      data = await this.init();
    } else {
      data = snapshot.data();
    }

    return StateFirestore.convertFromStorage(data);
  }

  /**
   * Due to [issue 213](https://github.com/cloudspannerecosystem/autoscaler/issues/213)
   * the docRef had to be changed, so check for an old doc at the old docref
   * If it exists, copy it to the new docref, delete it and return it.
   */
  async checkAndReplaceOldDocRef() {
    try {
      const oldDocRef = this.firestore.doc(
        `cloudsqlAutoscaler/${this.instanceId}`,
      );
      const snapshot = await oldDocRef.get();
      if (snapshot.exists) {
        logger.info(
          `Migrating firestore doc path from cloudsqlAutoscaler/${
            this.instanceId
          } to cloudsqlAutoscaler/state/${this.getCloudSQLId()}`,
        );
        await this.docRef.set(assertDefined(snapshot.data()));
        await oldDocRef.delete();
      }
      return snapshot;
    } catch (err) {
      logger.error({
        message: `Failed to migrate docpaths: ${err}`,
        err: err,
      });
    }
    return null;
  }

  /**
   * Update state data in storage with the given values
   * @param {StateData} stateData
   */
  async updateState(stateData) {
    stateData.updatedOn = this.now;

    const doc = StateFirestore.convertToStorage(stateData);

    // we never want to update createdOn
    delete doc.createdOn;

    await this.docRef.update(doc);
  }

  /** @inheritdoc */
  async close() {}
}
