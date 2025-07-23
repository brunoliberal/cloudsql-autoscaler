/**
 * 
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
 * limitations under the License.
 */

resource "google_service_account" "poller_sa" {
  project      = var.project_id
  account_id   = "poller-sa"
  display_name = "Autoscaler - Metrics Poller Service Account"
}

resource "google_service_account" "scaler_sa" {
  project      = var.project_id
  account_id   = "scaler-sa"
  display_name = "Autoscaler - Scaler Function Service Account"
}

module "autoscaler-base" {
  source = "../../modules/autoscaler-base"

  project_id      = var.project_id
  poller_sa_email = google_service_account.poller_sa.email
  scaler_sa_email = google_service_account.scaler_sa.email
}

module "autoscaler-functions" {
  source = "../../modules/autoscaler-functions"

  project_id      = var.project_id
  region          = var.region
  poller_sa_email = google_service_account.poller_sa.email
  scaler_sa_email = google_service_account.scaler_sa.email
  build_sa_id     = module.autoscaler-base.build_sa_id
}

module "firestore" {
  source = "../../modules/firestore"

  project_id      = var.project_id
  region          = var.region
  scaler_sa_email = google_service_account.scaler_sa.email
}

module "scheduler" {
  source = "../../modules/scheduler"

  project_id          = var.project_id
  location            = var.region
  pubsub_topic        = module.autoscaler-functions.poller_topic

  // Example of passing config as json
  // It can contain multiple CloudSQL instances
  // Check documentation for more info
  json_config = base64encode(jsonencode([{
    "projectId" : "<REPLACE_WITH_MY_PROJECT_ID>",
    "instanceId" : "<REPLACE_WITH_INSTANCE_ID",
    "stateProjectId" : "${var.project_id}",
    "scalerPubSubTopic" : "${module.autoscaler-functions.scaler_topic}",
    "units" : "VCPU",
    "minSize" : 2,
    "maxSize" : 16,
    "overloadStepSize" : 1,
    "overloadCoolingMinutes": 10,
    "scalingMethod" : "FIXED",
    "scaleOutCoolingMinutes" : 10,
    "scaleInCoolingMinutes" : 10
  }
  ]))

  paused = false
}

module "monitoring" {
  count  = var.terraform_dashboard ? 1 : 0
  source = "../../modules/monitoring"

  project_id = local.app_project_id
}

// Cloud build for terraform CI/CD
module "cloudbuild" {
  source     = "../../modules/cloudbuild"
  project_id = var.project_id
}
