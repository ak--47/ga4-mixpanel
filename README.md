# 🏎  GA4 to Mixpanel

Take your Google Analytics 4 data from BigQuery and bring it into Mixpanel! 

By leveraging [GA4's BigQuery connector](https://support.google.com/analytics/answer/9358801?hl=en) and [Mixpanel's data ingestion APIs](https://developer.mixpanel.com/reference/overview), here is a free-to-use serverless service to move your data from GA4 to Mixpanel at scale.

Intraday? Daily Tables? BOTH? You decide! 


## 🛠️  Deploy

the GA4 Mixpanel connector can be deploy as a Cloud Run or Cloud Function service. 

choose whichever you are more comfortable with; the functionality is identical


- **One Click Deploy**

deploy this service to cloud run with a single click!

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run)

^ you will be guided through a setup process where you will be prompted for your `BigQuery Dataset Id`, `Cloud Storage Bucket`, and `Mixpanel Token` 


- **Google Cloud Functions**


```bash
git clone https://github.com/ak--47/ga4-mixpanel
cd ga4-mixpanel
chmod +x deploy_cloud_functions.sh
npm run deploy:func
```
then read [**setup**](#setup)

- **Google Cloud Run**

alternatively use these commands to clone the repo and deploy the service:


```bash
git clone https://github.com/ak--47/ga4-mixpanel
cd ga4-mixpanel
chmod +x deploy_cloud_run.sh
npm run deploy:run
```
then read [**setup**](#setup)



## 📝  Setup

you will need to share the following values with you deployment:

- `BQ_DATASET_ID` : the name of your [BigQuery dataset for GA4 data](https://support.google.com/analytics/answer/9358801?hl=en&ref_topic=9359001&sjid=71950933165448838-NA)... usually like: `analytics_123456789`
- `GCS_BUCKET` : the name of the GCS bucket this service will use for temporary storage. [how to create a bucket](https://cloud.google.com/storage/docs/creating-buckets)
- `MP_TOKEN` : your mixpanel project's token, which you can find in the [project settings](https://developer.mixpanel.com/reference/project-token)


these values can be set as **environment variables** or in the `CONFIG.json` file

- **environment variables** can be set with a deployment flag: 

```--set-env-vars BQ_DATASET_ID=analytics_123456789 GCS_BUCKET=mp_bucky MP_TOKEN=987654321``` 

they can also be stored `.env.yaml` file referenced in the deployment with `--env-vars-file .env.yaml`

```yml
BQ_DATASET_ID: "analytics_123456789"
GCS_BUCKET: "mp_bucky"
MP_TOKEN: "987654321"
```

- for `CONFIG.json` ... just modify the file in the repo and redeploy the service

```json
{
    "BQ_DATASET_ID": "",
    "GCS_BUCKET": "",
    "MP_TOKEN": ""
}
```

there are more params you can set with env vars, json files, and even query string params when you call the service ... see [**params**](#params)


## 🌭  Usage

After you deploy the service, you should receive a canonical URL by which you can call it.

If you call the service with a plain `GET` request with no params to the `/` endpoint:

```
curl https://ga4-mixpanel-123456789-uc.a.run.app
```

this will export the **last hour of data** from GA4's intraday tables to cloud storage and then import reach row of the table to your Mixpanel project as data points.

if you turned intraday off in as a query param

```
curl https://ga4-mixpanel-123456789-uc.a.run.app?intraday=false
```
this will sync the **previous day's table** with Mixpanel (for yesterday's date)

if you wanted to sync a specific daily table for `12-23-2023` you would specify a `date` param like this:

```
curl https://ga4-mixpanel-123456789-uc.a.run.app?date=2023-12-23
```

this will sync the **daily table for 12-23-2023** with Mixpanel

all files generated by the service are stored in the `GCS_BUCKET` you specified during deployment; once each file is imported into Mixpanel, it is deleted from the bucket.

### 🪷  Params

there are a few other URL params you can specify:

| Parameter    | Default Value | Explanation                                                                                     |
|--------------|---------------|-------------------------------------------------------------------------------------------------|
| `table`      | (None)        | Specifies the BigQuery table to extract data from. If not provided, defaults to `events_<DATE>`. |                                             |
| `date`       | (None)        | The specific date for syncing data in `YYYYMMDD` format. Used for full-day syncing.             |
| `sql`        | "SELECT *"    | Custom SQL query to run against the BigQuery table. Default selects all data.                   |
| `lookback`   | 3600          | Time in seconds to look back for events in intraday tables.                                     |
| `late`       | 60            | Threshold in seconds for an event to be considered late (applicable for intraday data).         |
| `concurrency`| 30            | The number of concurrent requests made to Mixpanel.                                            |
| `days_ago`   | 2             | Sync data from a specific number of days ago. Useful for backfilling historical data. Takes priority over `date`          |
| `type`   | `event`             | `event`, `user`, or `group` to select the type of data you are importing          |

**note**: depending on your [deployment strategy](#deploy), you may get a service URL that looks like `{service-name}.run.app` or `{region}.cloudfunctions.net/{service-name}` 

the `.run.app` suffix is for Cloud Run (and Cloud Functions gen 2); the `cloudfunctions.net` suffix is for Cloud Functions. **It is strongly recommend that you use the Cloud Run style URLs for this service:**

```
# EXAMPLE SERVICE URLs
Cloud Functions: https://us-central1-mixpanel-gtm-training.cloudfunctions.net/ga4-mixpanel-func
					^  👎 don't use this one

Cloud Run: https://ga4-mixpanel-func-lmozz6xkha-uc.a.run.app
					^ 👍 use this one 
```

**note**:	^ if you use the cloud functions URL, you will need to pass the service it's own URL as an environment variable, JSON.config, or param to the service like this: `curl https://us-central1-mixpanel-gtm-training.cloudfunctions.net/ga4-mixpanel-func?URL=https://us-central1-mixpanel-gtm-training.cloudfunctions.net/ga4-mixpanel-func`

This service **needs to know its own URL**, so it can call itself. For some reason, the cloudfunction.net (gen 1) network gateway doesn't provide the full originalUrl in the request params, so it is impossible to derive at runtime. this is weird because with the Cloud Run style of URLs, this was not a problem.

Anyway, just do yourself a favor and use Cloud Run URLs (`*.run.app`) for this service!


## 🎻  Orchestration

Since the service's **default behavior** is to **sync the last hour of data**, you can schedule the service to run every hour to sync the last hour of data and create a real-time pipeline of data from GA4 to Mixpanel with less than 1hr of latency!

A cron expression like this will sync the last hour of data every hour:

```bash
0 * * * * 
```

Using a scheduler like [Google Cloud Scheduler](https://cloud.google.com/scheduler) you can call this service on a schedule to create an automated pipeline that works both with your intraday. 


Similarly, you can schedule the service to run once a day to sync the previous day's data from GA4 to Mixpanel. A cron expression like this will sync the previous day's data every day at 1am:

```bash
0 1 * * * 
```

One strategy is to use a combination of both intraday and daily syncing to create a pipeline that syncs the last hour of data every hour and the previous day's data every day. This will ensure that your Mixpanel project stays up-to-date with the latest GA4 data, as Mixpanel will deduplicate the data (based on a tuple of `user_pseudo_id`, `time`, and `event_name`).

## 🔬 How it Works

Based on the [GA4 BigQuery export schema](https://support.google.com/analytics/answer/7029846?hl=en&ref_topic=9359001&sjid=71950933165448838-NA), this service was designed to be used with "intraday" tables and "daily" tables, connecting all the default fields, and mapping GA4's identity fields to Mixpanel's.

1. **Data Extraction:** The service first runs a live query on your BigQuery GA4 dataset and the extracts the results of that query to cloud storage. It supports both intraday and full-day data extraction based on the provided parameters or defaults.

A full day query looks like this:

```sql
SELECT * FROM `analytics_123456789.events_20201223` 
```

An intraday query looks like this:

```sql
SELECT * FROM `analytics_123456789.events_intraday_*` 
WHERE
(
	-- events in the last hour + one minute
	(TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(CAST(event_timestamp / 1000 as INT64)), SECOND) <= 3600)
OR
	(
		-- events that were more than 30 seconds late
		event_server_timestamp_offset > 3000000 
		AND 
		-- events in the last 2 hours
		TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(CAST(event_timestamp / 1000 as INT64)), SECOND) <= 7200 
	)
)
```

The results of these queries are then exported to cloud storage as newline-delimited JSON files. 

2. **Data Transformation:** After extraction, the data is transformed into a format that is compatible with Mixpanel's import requirements. This step ensures that all the GA4 data fields are correctly mapped to Mixpanel's data schema.

**NOTE:** currently only [simple identity management](https://docs.mixpanel.com/docs/tracking-methods/identifying-users#simplified-vs-original-id-merge) is supported. this means that the service will use `user_pseudo_id` as `$device_id` and  `user_id` as `$user_id` which are the GA4 defaults.

3. **Data Loading**: The transformed data is then loaded into Mixpanel using `/import`, `/engage`, and `/group` APIs. The service handles the batching and uploading of data to ensure efficient and reliable data transfer.

4. **Error Handling and Logging**: Throughout the process, the service provides robust error handling and detailed logging. This helps in monitoring the sync process and quickly identifying any issues that may arise.

5. **Orchestration and Automation**: For continuous data syncing, the service can be scheduled to run at regular intervals (e.g., hourly) using Google Cloud Scheduler or a similar tool. This ensures that your Mixpanel project stays up-to-date with the latest GA4 data.

6. **Scalability and Performance**: The service is designed to handle large volumes of data efficiently. It uses concurrency control and rate limiting to manage the data flow without overwhelming the Mixpanel API. The service can also be scaled up or down based on your requirements.

7. **Security and Compliance**: The service adheres to best practices in terms of security and compliance, ensuring that your data is handled safely throughout the syncing process.

8. **Customization and Flexibility**: You can customize various aspects of the service (like concurrency levels, lookback period, etc.) to suit your specific requirements, providing flexibility in how you sync your data.

