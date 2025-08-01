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

variable "project_id" {
  type = string
}

variable "location" {
  type = string
}

variable "schedule" {
  type    = string
  default = "*/2 * * * *"
}

variable "time_zone" {
  type    = string
  default = "Australia/Sydney"
}

variable "paused" {
  type    = bool
  default = true
}

variable "pubsub_topic" {
  type = string
}

variable "json_config" {
  type        = string
  default     = ""
  description = "Base 64 encoded json that is the autoscaler configuration for the Cloud Scheduler payload. Using this allows for setting autoscaler configuration for multiple cloudsqls and parameters that are not directly exposed through variables."
}