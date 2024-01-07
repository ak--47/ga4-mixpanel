/***
 * GA4 to Mixpanel
 * purpose: sync GA4 events to Mixpanel; support intraday tables and backfilling
 * todo: group analytics
 * by ak@mixpanel.com
 *
 *
 */

// CLOUD DEPS
import functions from "@google-cloud/functions-framework";
import { BigQuery } from "@google-cloud/bigquery";
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";


// LOCAL DEPS
import Mixpanel from "mixpanel-import";
import pLimit from "p-limit";
import { parseGCSUri, sLog, timer, isNil, sleep } from "ak-tools";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
dayjs.extend(utc);
import dotenv from "dotenv";
dotenv.config();

// JSON 
import { readFileSync } from 'fs';
let JSON_CONFIG = {};
try {
	// Read the file from the top-level directory
	const rawData = readFileSync('./CONFIG.json', 'utf8');

	// Parse the JSON data
	JSON_CONFIG = JSON.parse(rawData);
} catch (error) {
	console.log("CONFIG.json not found or invalid. Using default configuration.");
}

// CONFIGURATION (effectively globals)
let {
	BQ_DATASET_ID = "", // dataset to sync
	BQ_TABLE_ID = "", // table to sync
	GCS_BUCKET = "", // gcs bucket to store temp files
	MP_TOKEN = "", // mp token
	MP_SECRET = "", // mp secret
	MP_PROJECT = "", // mp project id
	SQL = "SELECT *", // SQL query to run
	CONCURRENCY = 30, // how many requests to make at once
	LATE = 60, // how many seconds late is a late event (INTRADAY ONLY)
	LOOKBACK = 3600, // how many seconds to look back (INTRADAY ONLY)
	INTRADAY = true, // whether to sync intraday or whole table
	VERBOSE = false, // whether to log debug info
	DAYS_AGO = 1, // how many days ago to sync for whole table
	TYPE = "event", // event, user, group
	URL = "",
	SET_INSERT_ID = true,
	INSERT_ID_TUPLE = ["event_name", "user_pseudo_id", "event_bundle_sequence_id"],
	TIME_CONVERSION = "seconds"
} = JSON_CONFIG;

// LABELS
const timeFileLabel = dayjs.utc().format("DD-HH:mm");
let filePrefix = `temp`;
let fileName = `${filePrefix}-${timeFileLabel}-`;
let RUNTIME_URL = ""; // IMPORTANT: this is what allows the service to call itself

// ENV CONFIG
if (process.env.GCS_BUCKET) GCS_BUCKET = process.env.GCS_BUCKET;
if (process.env.BQ_DATASET_ID) BQ_DATASET_ID = process.env.BQ_DATASET_ID;
if (process.env.BQ_TABLE_ID) BQ_TABLE_ID = process.env.BQ_TABLE_ID;
if (process.env.URL) URL = process.env.URL;
if (process.env.SQL) SQL = process.env.SQL;

if (process.env.MP_SECRET) MP_SECRET = process.env.MP_SECRET;
if (process.env.MP_PROJECT) MP_PROJECT = process.env.MP_PROJECT;
if (process.env.MP_TOKEN) MP_TOKEN = process.env.MP_TOKEN;
if (process.env.TYPE) TYPE = process.env.TYPE;

if (process.env.CONCURRENCY) CONCURRENCY = parseInt(process.env.CONCURRENCY);
if (process.env.LATE) LATE = parseInt(process.env.LATE);
if (process.env.LOOKBACK) LOOKBACK = parseInt(process.env.LOOKBACK);
if (process.env.DAYS_AGO) DAYS_AGO = parseInt(process.env.DAYS_AGO);
if (process.env.INSERT_ID_TUPLE) INSERT_ID_TUPLE = process.env.INSERT_ID_TUPLE.split(",");
if (process.env.TIME_CONVERSION) TIME_CONVERSION = process.env.TIME_CONVERSION;
let DATE = dayjs.utc().subtract(DAYS_AGO, "d").format("YYYYMMDD");
let DATE_LABEL = dayjs.utc(DATE, "YYYYMMDD").format("YYYY-MM-DD");
// if (process.env.DATE) DATE = dayjs(process.env.DATE.toString()).format("YYYYMMDD");


if (process.env.INTRADAY) INTRADAY = strToBool(process.env.INTRADAY);
if (process.env.SET_INSERT_ID) SET_INSERT_ID = strToBool(process.env.SET_INSERT_ID);
if (process.env.VERBOSE) VERBOSE = strToBool(process.env.VERBOSE);

// THESE NEED TO BE SET GLOBALLY
if (!SQL) SQL = "SELECT *";


// GCP RESOURCES
const bigquery = new BigQuery();
const storage = new Storage();

// CREDENTIALS
/** @type {import('mixpanel-import').Creds} */
let creds = {};
if (MP_TOKEN) creds.token = MP_TOKEN;
if (MP_SECRET) creds.secret = MP_SECRET;
if (MP_PROJECT) creds.project = MP_PROJECT;

if (!["event", "user", "group"].includes(TYPE)) throw new Error(`TYPE must be one of: ${["event", "user", "group"]}`);


// MIXPANEL IMPORT OPTIONS
/** @type {import('mixpanel-import').Options} */
const opts = {
	vendor: "ga4",
	abridged: true,
	streamFormat: "jsonl",
	strict: false,
	verbose: false,
	workers: 10,
	compress: false,
	dryRun: false,
	flattenData: true,
	vendorOpts: {
		set_insert_id: SET_INSERT_ID,
		insert_id_tuple: INSERT_ID_TUPLE,
		time_conversion: "seconds"
	}
};


// ENTRY POINT
functions.http("go", async (req, res) => {

	try {
		// PROCESS PARAMS
		const queryString = process_request_params(req);

		// EXTRACT DATA
		if (req.method === "GET") {
			//having a 'DATE' and 'INTRADAY' is not supported
			if (INTRADAY) DATE = "";

			//setup file name
			fileName = `${TYPE}-`.concat(fileName);
			if (INTRADAY) fileName = `intraday-`.concat(fileName);
			if (!INTRADAY) fileName = `${DATE}-`.concat(fileName);
			DATE_LABEL = dayjs.utc(DATE, "YYYYMMDD").format("YYYY-MM-DD");

			const watch = timer("SYNC");
			watch.start();

			sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → SYNC START!`, {
				GCS_BUCKET,
				BQ_DATASET_ID,
				BQ_TABLE_ID,
				SQL,
				TYPE,
				CONCURRENCY,
				LATE,
				LOOKBACK,
				DAYS_AGO,
				DATE,
				INTRADAY,
				VERBOSE,
				URL,
				RUNTIME_URL,
				TIME_CONVERSION,
				INSERT_ID_TUPLE,
				SET_INSERT_ID
			}, "NOTICE");

			//allow for runtime url to be passed in
			if (URL) RUNTIME_URL = URL;

			const importTasks = await EXTRACT_GET(INTRADAY, queryString);

			sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → SYNC COMPLETE: ${watch.end()}`, importTasks, "NOTICE");

			res.status(200).send(importTasks);
			return;
		}

		// LOAD DATA
		if (req.method === "POST" && req.body && req.body.file) {
			const loadResult = await LOAD_POST(req.body.file);
			res.status(200).send(loadResult);
			return;
		}

		// DELETE DATA
		if (req.method === "DELETE") {
			const deleted = await STORAGE_DELETE();
			res.status(200).send({ deleted });
			return;
		}

		if (req.method === "PATCH") {
			const imported = await BACKFILL_PATCH();
			res.status(200).send(imported);
			return;
		}

		// FAIL
		res.status(400).send("Bad Request; expecting GET to extract or POST with file to load or DELETE to delete all files");
		return;
	} catch (err) {
		sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → JOB FAIL`, { path: req.path, method: req.method, params: req.params, body: req.body }, "CRITICAL");
		res.status(500).send({ error: err.message }); // Send back a JSON error message
	}
});



/*
----
CORE API
these are covered by e2e tests
----
*/

export async function EXTRACT_GET(INTRADAY = true, queryString = "") {
	const watch = timer("SYNC");
	watch.start();
	try {
		const QUERY = await build_sql_query(BQ_DATASET_ID, BQ_TABLE_ID, INTRADAY, LOOKBACK, LATE, TYPE, SQL);
		if (VERBOSE) sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → RUNNING QUERY`, { QUERY }, "DEBUG");
		const GCS_URIs = await bigquery_to_storage(QUERY);
		const importTasks = await spawn_file_workers(GCS_URIs, queryString);
		watch.end();
		return importTasks;
	} catch (error) {
		sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} →  SYNC FAIL: ${watch.end()}`, { message: error.message, stack: error.stack }, "CRITICAL");
		throw error;
	}
}

export async function STORAGE_DELETE() {
	const watch = timer("delete");
	watch.start();
	try {
		let deleted = 0;
		const [files] = await storage.bucket(GCS_BUCKET).getFiles();
		const fileToDelete = files.filter((file) => file.name.includes(filePrefix));

		// Define the concurrency limit, e.g., 5 tasks at a time
		const limit = pLimit(CONCURRENCY);

		// Create an array of promises, each limited by pLimit
		const deletePromises = fileToDelete.map((file) =>
			limit(async () => {
				await file.delete();
				return 1; // Return 1 for each successful deletion
			})
		);

		// Use Promise.allSettled to wait for all the delete operations to complete
		const results = await Promise.allSettled(deletePromises);

		// Count successful deletions
		deleted = results.reduce((acc, result) => acc + (result.status === "fulfilled" ? result.value : 0), 0);

		sLog(`STORAGE DELETE: ${watch.end()}`, { deleted });
		return deleted;
	}
	catch (error) {
		sLog(`STORAGE DELETE FAIL: ${watch.end()}`, { message: error.message, stack: error.stack }, "CRITICAL");
		throw error;
	}
}

export async function LOAD_POST(file) {
	const watch = timer("LOAD");
	watch.start();
	try {
		const importJob = await storage_to_mixpanel(file);
		if (VERBOSE) sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → ${parseGCSUri(file).file}: ${watch.end()}`, importJob, "DEBUG");
		return importJob;
	} catch (error) {
		sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → ${file}: ${watch.end()}`, { message: error.message, stack: error.stack }, "ERROR");
		throw error;
	}
}

export async function BACKFILL_PATCH() {
	const watch = timer("IMPORT");
	watch.start();
	try {
		const [files] = await storage.bucket(GCS_BUCKET).getFiles();
		const GCS_URIs = files.filter((file) => file.name.includes(filePrefix)).map((file) => `gs://${GCS_BUCKET}/${file.name}`);
		const importTasks = await spawn_file_workers(GCS_URIs);
		watch.end();
		return importTasks;
	} catch (error) {
		sLog(`IMPORT FAIL: ${watch.end()}`, { message: error.message, stack: error.stack }, "CRITICAL");
		throw error;
	}
}


/*
----
BUSINESS LOGIC
these are largely untested
----
*/


export async function bigquery_to_storage(query) {
	const watch = timer("bigquery");
	watch.start();
	const jobConfig = {
		query,
		location: "US", // Change this to match your dataset's location
		destination: null, // This creates a temporary table for query results
		writeDisposition: "WRITE_TRUNCATE", // Overwrites the table if it already exists
	};

	let job;
	try {
		// @ts-ignore
		[job] = await bigquery.createQueryJob(jobConfig);
		await poll_job(job);
	} catch (error) {
		sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → BIGQUERY FAIL: ${watch.end()}`, { message: error.message, stack: error.stack }, "CRITICAL");
		throw error;
	}

	const destinationTable = job.metadata.configuration.query.destinationTable;
	const destination = storage.bucket(GCS_BUCKET).file(fileName.concat("*.jsonl"));

	// Create a job to export the data from the temporary table to GCS
	const [exportJob] = await bigquery.dataset(destinationTable.datasetId).table(destinationTable.tableId).extract(destination, { format: "JSON", gzip: false });

	const [files] = await storage.bucket(GCS_BUCKET).getFiles({ prefix: fileName });
	const uris = files.map((file) => `gs://${GCS_BUCKET}/${file.name}`);

	sLog(
		`${INTRADAY ? "INTRADAY" : DATE_LABEL} → BIGQUERY EXPORT: ${watch.end()}`,
		{
			NUMBER_OF_FILES: files.length,
			...exportJob,
		},
		"INFO"
	);

	return uris;
}

export async function storage_to_mixpanel(filePath) {
	const { bucket, file, uri } = parseGCSUri(filePath);
	const data = await storage.bucket(bucket).file(file);

	try {
		const watch = timer("file");
		watch.start();
		await checkFileExists(data, filePath);

		const [date, recordType] = file.split("-");
		const dateLabel = dayjs.utc(date, "YYYYMMDD").format("YYYY-MM-DD");

		// @ts-ignore
		opts.recordType = recordType;

		if (opts.recordType === "event") {
			if (filePath.includes("intraday")) opts.tags = { import_type: "intraday" };
			if (!filePath.includes("intraday")) opts.tags = { import_type: `daily: ${dateLabel || ""}` };
		}

		if (opts.recordType === "user") {
			opts.dedupe = true;
			opts.abridged = false;
			opts.transformFunc = (data) => {
				data["$token"] = MP_TOKEN;
				return data;
			};
		}

		// Pass the file to Mixpanel
		const result = await Mixpanel(creds, data.createReadStream({ decompress: true }), opts);

		// Delete the file from GCS
		await data.delete();
		return result;

	} catch (error) {
		sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → Mixpanel Error: ${filePath}`, { file, message: error.message, stack: error.stack }, "ERROR");
		throw error;
	}
}

/**
 * @typedef {import('mixpanel-import').ImportResults} ImportResults
 */
export async function spawn_file_workers(uris, queryString = "") {
	const auth = new GoogleAuth();
	let client;
	if (RUNTIME_URL.includes('localhost')) {
		client = await auth.getClient();
	}
	else {
		client = await auth.getIdTokenClient(RUNTIME_URL);
	}

	const limit = pLimit(CONCURRENCY);
	const requestPromises = uris.map((uri) => {
		return limit(() => build_request(client, uri, queryString));
	});
	const complete = await Promise.allSettled(requestPromises);
	const results = {
		files_success: complete.filter((p) => p.status === "fulfilled").length,
		files_failed: complete.filter((p) => p.status === "rejected").length,
		files_total: complete.length,
	};

	// @ts-ignore
	const receipts = complete.filter((p) => p.status === "fulfilled").map((p) => p.value);
	results.summary = aggregateImportResults(receipts);
	return results;
}


/*
----
HELPERS
these are covered by unit tests
----
*/

// THIS IS ALL SIDE EFFECTS
export function process_request_params(req) {
	//URL
	// for cloud run
	const protocol = req.protocol || 'http';
	const host = req.get('host');
	const forwardedPath = req.get('X-Forwarded-Path') || ''; // Adjust header key if necessary
	const path = forwardedPath || req.path;

	//for cloud functions
	const functionName = process.env.FUNCTION_NAME || process.env.K_SERVICE;
	//edit: these do not work...
	const region = process.env.REGION; // Optionally, you can get the region too
	const project = process.env.GCLOUD_PROJECT; // Project ID is also available as an environment variable

	const isCloudFunction = !!process.env.FUNCTION_NAME || !!process.env.FUNCTION_TARGET;

	if (!URL) {
		if (isCloudFunction) {
			RUNTIME_URL = `${protocol}://${region}-${project}.cloudfunctions.net/${functionName}`;
		}
		else {
			RUNTIME_URL = `${protocol}://${host}${path}`;
		}
	}


	//strings
	BQ_TABLE_ID = req.query.table?.toString() || BQ_TABLE_ID;
	BQ_DATASET_ID = req.query.dataset?.toString() || BQ_DATASET_ID;
	GCS_BUCKET = req.query.bucket?.toString() || GCS_BUCKET;
	MP_TOKEN = req.query.token?.toString() || MP_TOKEN;
	MP_SECRET = req.query.secret?.toString() || MP_SECRET;
	DATE = req.query.date ? dayjs(req.query.date.toString()).format("YYYYMMDD") : DATE;
	TYPE = req.query.type ? req.query.type.toString() : TYPE;
	URL = req.query.url ? req.query.url.toString() : URL;
	if (URL) RUNTIME_URL = URL;
	TIME_CONVERSION = req.query.time_conversion ? req.query.time_conversion.toString() : TIME_CONVERSION;


	//numbers
	LOOKBACK = req.query.lookback ? parseInt(req.query.lookback.toString()) : LOOKBACK;
	LATE = req.query.late ? parseInt(req.query.late.toString()) : LATE;
	CONCURRENCY = req.query.concurrency ? parseInt(req.query.concurrency.toString()) : CONCURRENCY;
	DAYS_AGO = req.query.days_ago ? parseInt(req.query.days_ago.toString()) : DAYS_AGO;
	if (req.query.days_ago) DATE = dayjs.utc().subtract(DAYS_AGO, "d").format("YYYYMMDD");
	if (!req.query.days_ago && !req.query.date) {
		//DAYS_AGO = null;
		//DATE = "";
	}


	//switches
	INTRADAY = !isNil(req.query.intraday) ? strToBool(req.query.intraday) : INTRADAY;
	VERBOSE = !isNil(req.query.verbose) ? strToBool(req.query.verbose) : VERBOSE;
	SET_INSERT_ID = !isNil(req.query.set_insert_id) ? strToBool(req.query.set_insert_id) : SET_INSERT_ID;

	// if the user specifies a date, we assume they want a full day
	if (req.query.date) INTRADAY = false;

	if (!MP_TOKEN && !MP_SECRET) throw new Error("mixpanel 'token'' or 'secret' is required");
	if (!GCS_BUCKET) throw new Error("google cloud 'bucket' is required");
	if (!BQ_DATASET_ID) throw new Error("bigquery 'dataset' is required");
	if (!BQ_TABLE_ID) BQ_TABLE_ID = `events_${DATE}`; //date = today if not specified
	if (MP_TOKEN) creds.token = MP_TOKEN;


	//return fully constructed query params
	// Initialize an object to hold parameters
	let params = {};

	// Loop through req.query and populate the params object
	for (const key in req.query) {
		if (req.query[key]) {
			params[key] = req.query[key].toString();
		}
	}
	// Construct query string
	const queryString = Object.keys(params)
		.filter(key => params[key] != null) // Filter out null or undefined values
		.map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
		.join('&');

	return queryString;

}


export async function poll_job(job) {
	// Poll the job status without fetching the query result rows
	let jobMetadata;
	do {
		await new Promise((resolve) => setTimeout(resolve, 5000)); // 5 seconds delay
		[jobMetadata] = await job.getMetadata();
	} while (jobMetadata.status.state !== "DONE");

	if (jobMetadata.status.errorResult) {
		throw new Error(`Job failed with error ${jobMetadata.status.errorResult.message}`);
	}
}

/**
 * @param  {import('google-auth-library').IdTokenClient} client
 * @param  {string} uri
 * @return {Promise<ImportResults | {}>}
 */
export async function build_request(client, uri, queryString = "") {
	try {
		let retryAttempt = 0;
		const req = await client.request({
			url: RUNTIME_URL + "?" + queryString,
			method: "POST",
			data: { file: uri },
			headers: {
				"Content-Type": "application/json",
			},
			retryConfig: {
				retry: 5,
				statusCodesToRetry: [
					[100, 199],
					[400, 499],
					[500, 599],
				],
				shouldRetry: (error) => {
					if (error && error.code === "ECONNRESET") {
						return Promise.resolve(true);
					}
					if (error.code === "500") {
						return Promise.resolve(true);
					}
					const statusCode = error?.response?.status?.toString() || "";
					if (statusCode.startsWith("5") || statusCode.startsWith("4")) {
						return Promise.resolve(true);
					}

					return Promise.resolve(false);
				},
				onRetryAttempt: (error) => {
					const statusCode = error?.response?.status?.toString() || "";
					retryAttempt++;
					if (VERBOSE) sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → retry #${retryAttempt} for ${uri}`, { statusCode, message: error.message, stack: error.stack }, "DEBUG");
				}
			},
		});
		const { data } = req;
		return data;
	} catch (error) {
		sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → REQUEST FAILED: ${uri}:`, { message: error.message, stack: error.stack, code: error.code }, "ERROR");
		return {};
	}
}

/**
 * @param  {string} TABLE_ID
 * @param  {string | boolean} [intraday=false]
 * @param  {number} [lookBackWindow=3600]
 * @param  {number} [late=60]
 * @param  {string} [type="event"]
 */
export async function build_sql_query(BQ_DATASET_ID, TABLE_ID, intraday = false, lookBackWindow = 3600, late = 60, type = "event", SQL = "SELECT *") {
	// i.e. intraday vs full day
	// .events_intraday_*
	// .events_*  or .events_20231222
	let query = `${SQL} FROM \`${BQ_DATASET_ID}.`;

	// table name
	if (intraday) {
		query += `events_intraday_*\``;
	} else {
		query += `${TABLE_ID}\``;
	}

	// where
	if (intraday || type === "user") {
		query += `\nWHERE\n`;
	}

	// user props
	if (type === "user") {
		query += `(user_properties IS NOT NULL)`;
	}
	if (intraday && type === "user") {
		query += `\nAND\n`;
	}

	// intraday events
	// events in the last lookBackWindow (seconds)
	if (intraday) {
		query += `((TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(CAST(event_timestamp / 1000 as INT64)), SECOND) <= ${lookBackWindow})`;
		query += `\nOR\n`;
	}

	// events that are late (seconds)
	if (intraday) {
		query += `(event_server_timestamp_offset > ${late * 1000000} AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(CAST(event_timestamp / 1000 as INT64)), SECOND) <= ${lookBackWindow * 2}))`;
	}

	return Promise.resolve(query);
}


export async function checkFileExists(fileObject, filePath) {
	// Retry mechanism for checking file existence
	let exists = false;
	for (let attempt = 1; attempt <= 10; attempt++) {
		[exists] = await fileObject.exists();
		if (exists) break;

		if (VERBOSE) sLog(`${INTRADAY ? "INTRADAY" : DATE_LABEL} → ${filePath} not found retry (${attempt}/10)`, {}, "INFO");
		await sleep(10000); // 10 seconds delay
	}

	if (!exists) {
		throw new Error(`File not found after multiple attempts: ${filePath}`);
	}

	return exists;


}

export function strToBool(string) {
	if (typeof string !== "string") {
		return Boolean(string);
	}

	switch (string.toLowerCase().trim()) {
		case "true":
			return true;
		case "yes":
			return true;
		case "1":
			return true;
		case "false":
			return false;
		case "no":
			return false;
		case "0":
			return false;
		case "":
			return false;
		default:
			return Boolean(string);
	}
}

/**
 * @param  {ImportResults[]} results
 */
export function aggregateImportResults(results) {

	const template = {
		success: 0,
		failed: 0,
		total: 0,
		eps: 0,
		mbps: 0,
		rps: 0,
		bytes: 0,
		duration: 0,
		rateLimit: 0,
		clientErrors: 0,
		serverErrors: 0,
		batches: 0,
		requests: 0,
		retries: 0,
		errors: [],
		duplicates: 0
	};

	if (!Array.isArray(results)) return template;
	if (!results.length) return template;
	const summary = results.reduce(
		/**
		 * @param  {ImportResults} acc
		 * @param  {ImportResults} curr
		 */
		function (acc, curr) {
			// Summing properties
			acc.success += curr.success;
			acc.failed += curr.failed;
			acc.total += curr.total;
			acc.bytes += curr.bytes;
			acc.duration += curr.duration;
			acc.rateLimit += curr.rateLimit;
			acc.clientErrors += curr.clientErrors;
			acc.serverErrors += curr.serverErrors;
			acc.batches += curr.batches;
			acc.requests += curr.requests;
			acc.retries += curr.retries;
			acc.errors.push(...curr.errors);
			acc.duplicates += curr.duplicates;


			// Accumulating for averaging later
			acc.eps += curr.eps;
			acc.mbps += curr.mbps;
			acc.rps += curr.rps;

			// ... handle other properties as needed

			return acc;
		},
		// @ts-ignore
		template
	);

	// Averaging properties
	const count = results.length;
	summary.eps /= count;
	summary.mbps /= count;
	summary.rps /= count;
	// ... average other properties as needed

	return summary;
}
