# GA4 to Mixpanel

Take your Google Analytics 4 data from BigQuery and rETL it to Mixpanel! 

Real-time? Batch? BOTH? You decide! 

## Deploy

this package works in either Cloud Run or Cloud Functions. the functionality is identical, but the deployment is slightly different.


- **Google Cloud Run**

deploy this service to cloud run with a single click!

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run)


or these commands:

```bash
git clone https://github.com/ak--47/ga4-mixpanel
cd ga4-mixpanel
chmod +x deploy.sh
npm run deploy:run
```

then read **setup** 


- **Google Cloud Functions**


```bash
git clone https://github.com/ak--47/ga4-mixpanel
cd ga4-mixpanel
npm run deploy:func
```
this will deploy the `ga4-mixpanel` service to your Google Cloud project using the following configuration:

```bash
gcloud functions deploy ga4-mixpanel --gen2 --runtime nodejs20 --region us-central1 --trigger-http --memory 2GB --cpu 1 --entry-point go --source . --timeout=3600 --no-allow-unauthenticated --max-instances=1000 --min-instances=0 --concurrency=5
```

## Setup

you will need to expose the following values to your service:

- `BQ_DATASET_ID` : the name of your [BigQuery dataset for GA4 data](https://support.google.com/analytics/answer/9358801?hl=en&ref_topic=9359001&sjid=71950933165448838-NA)... usually like: `analyitcs_123456789`
- `GCS_BUCKET` : the name of the GCS bucket this service will use for temporary storage. [how to create a bucket](https://cloud.google.com/storage/docs/creating-buckets)
- `MP_TOKEN` : your mixpanel project's token, which you can find in the [project settings](https://developer.mixpanel.com/reference/project-token)
- `URL` : the production URL of YOUR deployed service; you will receive this value after you deploy the service for the first time (e.g. `https://ga4-mixpanel-123456789-uc.a.run.app`)

these values can be set as **environment variables** or in the `CONFIG.json` file

- environment variables can be set as a deployment flag: ```--set-env-vars BQ_DATASET_ID=analytics_123456789``` or they can be stored in an `.env.yaml` file flagged  like `--env-vars-file .env.yaml`

- for `CONFIG.json` ... just modify the file in the repo and redeploy the service

**IMPORTANT**
when you deploy the service for the first time, you will receive a URL like `https://ga4-mixpanel-123456789-uc.a.run.app` ... This service **needs to know its own URL**, so it can call itself. You will get the `URL` after you deploy the service for the FIRST TIME. You will then need to add the `URL` and redeploy the service before attempting to sync data.



## Usage

After you deploy the service, you can call it with a `GET` request to the `/` endpoint of the URL you received after deployment. 

```
curl https://ga4-mixpanel-123456789-uc.a.run.app
```

this will sync the last hour of data from GA4's intraday tables to your Mixpanel project

if you wanted to sync a daily table for `12-23-2023` you can specify a `DATE` param like this:

```
curl https://ga4-mixpanel-123456789-uc.a.run.app?DATE=2023-12-23
```

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





## Orchestration

Using a scheduler like [Google Cloud Scheduler](https://cloud.google.com/scheduler) you can call this service on a schedule to create an automated.

Since the service's default behavior is to sync the last hour of data, you can schedule the service to run every hour to sync the last hour of data and create a live pipeline of data from GA4 to Mixpanel.

A cron expression like this will sync the last hour of data every hour:

```bash
0 * * * * 
```


## How it Works

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

2. **Data Transformation:** After extraction, the data is transformed into a format that is compatible with Mixpanel's import requirements. This step ensures that all the GA4 data fields are correctly mapped to Mixpanel's data schema.

**NOTE:** currently only [simple identity management](https://docs.mixpanel.com/docs/tracking-methods/identifying-users#simplified-vs-original-id-merge) is supported. this means that the service will use `user_pseudo_id` as `$device_id` and  `user_id` as `$user_id` which are the GA4 defaults.

3. **Data Loading**: The transformed data is then loaded into Mixpanel using its import API. The service handles the batching and uploading of data to ensure efficient and reliable data transfer.

4. **Error Handling and Logging**: Throughout the process, the service provides robust error handling and detailed logging. This helps in monitoring the sync process and quickly identifying any issues that may arise.

5. **Orchestration and Automation**: For continuous data syncing, the service can be scheduled to run at regular intervals (e.g., hourly) using Google Cloud Scheduler or a similar tool. This ensures that your Mixpanel project stays up-to-date with the latest GA4 data.

6. **Scalability and Performance**: The service is designed to handle large volumes of data efficiently. It uses concurrency control and rate limiting to manage the data flow without overwhelming the Mixpanel API.

7. **Security and Compliance**: The service adheres to best practices in terms of security and compliance, ensuring that your data is handled safely throughout the syncing process.

8. **Customization and Flexibility**: You can customize various aspects of the service (like concurrency levels, lookback period, etc.) to suit your specific requirements, providing flexibility in how you sync your data.

