/***
 * GA4 to Mixpanel
 * purpose: sync GA4 events to Mixpanel; support intraday tables and backfilling
 * todo: group analytics
 * todo: one click deploys
 * by ak@mixpanel.com
 *
 *
 */

import functions from "@google-cloud/functions-framework";
import { BigQuery } from "@google-cloud/bigquery";
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";
import Mixpanel from "mixpanel-import";
import pLimit from "p-limit";
import recon from "./recon.js";
import { parseGCSUri, sLog, timer, isNil } from "ak-tools";

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
dayjs.extend(utc);
import dotenv from "dotenv";
dotenv.config();

// these were used when NOT streaming E2E
// import path from "path";
// import os from "os";
// import fs from "fs";

// TODAY STUFF
const timeFileLabel = dayjs.utc().format("DD-HH:mm");

const filePrefix = `tempFile`;
const fileName = `${filePrefix}-${timeFileLabel}-`;

import JSON_CONFIG from "./CONFIG.json" assert { type: "json" };
let {
	BQ_DATASET_ID = "",
	BQ_TABLE_ID = "",
	GCS_BUCKET = "",
	MP_TOKEN = "",
	MP_SECRET = "",
	MP_PROJECT = "",
	URL = ``,
	SQL = "SELECT *",
	CONCURRENCY = 30, // how many requests to make at once
	LATE = 60, // how many seconds late is a late event (INTRADAY ONLY)
	LOOKBACK = 3600, // how many seconds to look back (INTRADAY ONLY)
	INTRADAY = true,
	VERBOSE = false,
	DAYS_AGO = 2,
	TYPE = "event",
} = JSON_CONFIG;


// GCP
if (process.env.GCS_BUCKET) GCS_BUCKET = process.env.GCS_BUCKET;
if (process.env.BQ_DATASET_ID) BQ_DATASET_ID = process.env.BQ_DATASET_ID;
if (process.env.BQ_TABLE_ID) BQ_TABLE_ID = process.env.BQ_TABLE_ID;
if (process.env.URL) URL = process.env.URL;
if (process.env.SQL) SQL = process.env.SQL;

// MIXPANEL 
if (process.env.MP_SECRET) MP_SECRET = process.env.MP_SECRET;
if (process.env.MP_PROJECT) MP_PROJECT = process.env.MP_PROJECT;
if (process.env.MP_TOKEN) MP_TOKEN = process.env.MP_TOKEN;
if (process.env.TYPE) TYPE = process.env.TYPE;


// INTRADAY
if (process.env.CONCURRENCY) CONCURRENCY = parseInt(process.env.CONCURRENCY);
if (process.env.LATE) LATE = parseInt(process.env.LATE);
if (process.env.LOOKBACK) LOOKBACK = parseInt(process.env.LOOKBACK);
if (process.env.DAYS_AGO) DAYS_AGO = parseInt(process.env.DAYS_AGO);
let DATE = dayjs.utc().subtract(DAYS_AGO, "d").format("YYYYMMDD");
if (process.env.DATE) DATE = dayjs(process.env.DATE.toString()).format("YYYYMMDD");


if (process.env.INTRADAY) INTRADAY = stringToBoolean(process.env.INTRADAY);
if (process.env.VERBOSE) VERBOSE = stringToBoolean(process.env.VERBOSE);

if (!SQL) SQL = "SELECT *";
if (!URL) sLog('URL MUST BE SET IN CONFIG.JSON OR AS ENV VAR', {}, "CRITICAL");

if (!GCS_BUCKET) sLog('GCS_BUCKET MUST BE SET IN CONFIG.JSON OR AS ENV VAR', {}, "CRITICAL");
// <-- TODO: make this dynamic ?!?!?

// GCP RESOURCES
const bigquery = new BigQuery();
const storage = new Storage();



// CREDENTIALS
/** @type {import('mixpanel-import').Creds} */
const creds = {};
if (MP_TOKEN) creds.token = MP_TOKEN;
if (MP_SECRET) creds.secret = MP_SECRET;
if (MP_PROJECT) creds.project = MP_PROJECT;

if (!["event", "user", "group"].includes(TYPE)) throw new Error(`TYPE must be one of: ${["event", "user", "group"]}`);

/** @type {import('mixpanel-import').RecordType} */
// @ts-ignore
const recordType = TYPE;

// MIXPANEL IMPORT OPTIONS
/** @type {import('mixpanel-import').Options} */
const opts = {
	vendor: "ga4",
	recordType,
	abridged: true,
	streamFormat: "jsonl",
	strict: false,
	verbose: false,
	workers: 10,
	compress: false,
	dryRun: false,
	flattenData: true,
};


// ENTRY POINT
functions.http("go", async (req, res) => {
	try {
		// INSTANCE METADATA
		if (req.method === "OPTIONS") {
			const metadata = await recon();
			sLog("METADATA", metadata, "NOTICE");
			res.status(200).send(metadata);
			return;
		}

		// EXTRACT DATA
		if (req.method === "GET" || (req.method === "PATCH" && req.body && req.body.sql)) {
			//note: query params OVERRIDE env vars

			//strings
			BQ_TABLE_ID = req.query.table?.toString() || BQ_TABLE_ID;
			BQ_DATASET_ID = req.query.dataset?.toString() || BQ_DATASET_ID;
			MP_TOKEN = req.query.token?.toString() || MP_TOKEN;
			DATE = req.query.date ? dayjs(req.query.date.toString()).format("YYYYMMDD") : DATE;
			SQL = req.body.sql ? req.body.sql.toString() : SQL;

			//numbers
			LOOKBACK = req.query.lookback ? parseInt(req.query.lookback.toString()) : LOOKBACK;
			LATE = req.query.late ? parseInt(req.query.late.toString()) : LATE;
			CONCURRENCY = req.query.concurrency ? parseInt(req.query.concurrency.toString()) : CONCURRENCY;

			//switches
			INTRADAY = !isNil(req.query.intraday) ? stringToBoolean(req.query.intraday) : INTRADAY;

			if (!MP_TOKEN && !MP_SECRET) throw new Error("MP_TOKEN or MP_SECRET is required");
			if (!BQ_TABLE_ID) BQ_TABLE_ID = `events_${DATE}`; //date = today if not specified

			//having a 'DATE' and 'INTRADAY' is not supported
			if (INTRADAY) DATE = "";

			const watch = timer("SYNC");
			watch.start();
			
			sLog("SYNC START!", {
				GCS_BUCKET,
				BQ_DATASET_ID,
				BQ_TABLE_ID,
				URL,
				SQL,
				TYPE,
				CONCURRENCY,
				LATE,
				LOOKBACK,
				DAYS_AGO,
				DATE,
				INTRADAY,
				VERBOSE
			}, "NOTICE");
			
			const importTasks = await EXTRACT_JOB(INTRADAY);
			
			sLog(`SYNC COMPLETE: ${watch.end()}`, importTasks, "NOTICE");

			res.status(200).send(importTasks);
			return;
		}

		// LOAD DATA
		if (req.method === "POST" && req.body && req.body.file) {
			const loadResult = await LOAD_JOB(req.body.file);
			res.status(200).send(loadResult);
			return;
		}

		// DELETE DATA
		if (req.method === "DELETE") {
			const deleted = await deleteAllFilesFromBucket();
			res.status(200).send({ deleted });
			return;
		}

		// FAIL
		res.status(400).send("Bad Request; expecting GET to extract or POST with file to load or DELETE to delete all files");
		return;
	} catch (err) {
		sLog("JOB FAIL", { path: req.path, method: req.method, params: req.params, body: req.body }, "CRITICAL");
		res.status(500).send({ error: err.message }); // Send back a JSON error message
	}
});

/*
----
EXTRACT
----
*/


export async function EXTRACT_JOB(INTRADAY = true) {
	const watch = timer("SYNC");
	watch.start();
	try {
		const QUERY = await buildSQLQuery(BQ_DATASET_ID, BQ_TABLE_ID, INTRADAY, LOOKBACK, LATE, TYPE, SQL);
		if (VERBOSE) sLog(`RUNNING ${INTRADAY ? "INTRADAY" : "WHOLE TABLE"} QUERY`, { QUERY }, "DEBUG");
		const GCS_URIs = await exportQueryResultToGCS(QUERY);
		const importTasks = await loadGCSToMixpanel(GCS_URIs);
		watch.end();
		return importTasks;
	} catch (error) {
		sLog(`SYNC FAIL: ${watch.end()}`, { message: error.message, stack: error.stack }, "CRITICAL");
		throw error;
	}
}
/**
 * @param  {string} TABLE_ID
 * @param  {string | boolean} [intraday=false]
 * @param  {number} [lookBackWindow=3600]
 * @param  {number} [late=60]
 * @param  {string} [type="event"]
 */
async function buildSQLQuery(BQ_DATASET_ID, TABLE_ID, intraday = false, lookBackWindow = 3600, late = 60, type = "event", SQL = "SELECT *") {
	// i.e. intraday vs full day
	// .events_intraday_*
	// .events_*  or .events_20231222
	let query = `${SQL} FROM \`${BQ_DATASET_ID}.`;
	if (intraday) query += `events_intraday_*\``;
	if (!intraday) query += `${TABLE_ID}\``;
	if (intraday || type === "user") query += `\nWHERE\n`;

	if (type === "user") query += `(user_properties IS NOT NULL)`;
	if (intraday && type === "user") query += `\nAND\n`;

	// events in the last lookBackWindow (seconds)
	if (intraday) query += `((TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(CAST(event_timestamp / 1000 as INT64)), SECOND) <= ${lookBackWindow + 60})`;
	if (intraday) query += `\nOR\n`;
	// events that are late (seconds)
	if (intraday) query += `(event_server_timestamp_offset > ${(late + 30) * 1000000} AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(CAST(event_timestamp / 1000 as INT64)), SECOND) <= ${lookBackWindow * 2
		}))`;

	return Promise.resolve(query);
}

async function exportQueryResultToGCS(query) {
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
		await pollJob(job);
	} catch (error) {
		sLog(`BIGQUERY FAIL: ${watch.end()}`, { message: error.message, stack: error.stack }, "CRITICAL");
		throw error;
	}

	const destinationTable = job.metadata.configuration.query.destinationTable;
	const destination = storage.bucket(GCS_BUCKET).file(fileName.concat("*.jsonl"));

	// Create a job to export the data from the temporary table to GCS
	const [exportJob] = await bigquery.dataset(destinationTable.datasetId).table(destinationTable.tableId).extract(destination, { format: "JSON", gzip: false });

	const [files] = await storage.bucket(GCS_BUCKET).getFiles({ prefix: fileName });
	const uris = files.map((file) => `gs://${GCS_BUCKET}/${file.name}`);

	sLog(
		`BIGQUERY EXPORT: ${watch.end()}`,
		{
			NUMBER_OF_FILES: files.length,
			...exportJob,
		},
		"INFO"
	);

	return uris;
}

async function pollJob(job) {
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
 * @typedef {import('mixpanel-import').ImportResults} ImportResults
 */

async function loadGCSToMixpanel(uris) {
	const auth = new GoogleAuth();
	const client = await auth.getIdTokenClient(URL);
	const limit = pLimit(CONCURRENCY);
	const requestPromises = uris.map((uri) => {
		return limit(() => makeRequest(client, uri));
	});
	const complete = await Promise.allSettled(requestPromises);
	const results = {
		success: complete.filter((p) => p.status === "fulfilled").length,
		failed: complete.filter((p) => p.status === "rejected").length,
	};

	// @ts-ignore
	const receipts = complete.filter((p) => p.status === "fulfilled").map((p) => p.value);
	results.summary = summarizeImportResults(receipts);
	results.total = results.success + results.failed;
	results.successRate = results.success / results.total;
	return results;
}

/**
 * @param  {import('google-auth-library').IdTokenClient} client
 * @param  {string} uri
 * @return {Promise<ImportResults | {}>}
 */
async function makeRequest(client, uri) {
	try {
		const req = await client.request({
			url: URL,
			method: "POST",
			data: { file: uri },
			headers: {
				"Content-Type": "application/json",
			},
			retryConfig: {
				retry: 10,
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
			},
		});
		const { data } = req;
		return data;
	} catch (error) {
		sLog(`Error triggering function for ${uri}:`, { message: error.message, stack: error.stack }, "ERROR");
		return {};
	}
}

/*
----
LOAD
----
*/

export async function LOAD_JOB(file) {
	const watch = timer("LOAD");
	watch.start();
	try {
		const importJob = await GCStoMixpanel(file);
		if (VERBOSE) sLog(`LOAD ${parseGCSUri(file).file}: ${watch.end()}`, importJob, "DEBUG");
		return importJob;
	} catch (error) {
		sLog(`LOAD FAIL: ${watch.end()}`, { message: error.message, stack: error.stack }, "ERROR");
		throw error;
	}
}

async function GCStoMixpanel(filePath) {
	const { bucket, file, uri } = parseGCSUri(filePath);
	const data = await storage.bucket(bucket).file(file);
	// const localFilePath = path.join(os.tmpdir(), file);

	try {
		const watch = timer("file");
		watch.start();
		// Download file to a temporary location
		// await data.download({ destination: localFilePath, validation: false });

		// Pass the file to Mixpanel
		const result = await Mixpanel(creds, data.createReadStream({ decompress: true }), opts);

		// Delete the file from temporary storage
		// fs.unlinkSync(localFilePath);

		// Delete the file from GCS
		await data.delete();
		return result;
	} catch (error) {
		sLog("Error processing file:", { file, message: error.message, stack: error.stack }, "ERROR");
		throw error;
	}
}

async function deleteAllFilesFromBucket() {
	const watch = timer("delete");
	watch.start();
	let deleted = 0;
	const [files] = await storage.bucket(GCS_BUCKET).getFiles({ prefix: filePrefix });

	// Define the concurrency limit, e.g., 5 tasks at a time
	const limit = pLimit(CONCURRENCY);

	// Create an array of promises, each limited by pLimit
	const deletePromises = files.map((file) =>
		limit(async () => {
			await file.delete();
			return 1; // Return 1 for each successful deletion
		})
	);

	// Use Promise.allSettled to wait for all the delete operations to complete
	const results = await Promise.allSettled(deletePromises);

	// Count successful deletions
	deleted = results.reduce((acc, result) => acc + (result.status === "fulfilled" ? result.value : 0), 0);

	sLog(`STORAGE DELETE: ${watch.end()}`);
	return deleted;
}

/*
----
HELPERS
----
*/

function stringToBoolean(string) {
	if (typeof string !== "string") {
		return Boolean(string);
	}

	switch (string.toLowerCase().trim()) {
		case "true":
		case "yes":
		case "1":
			return true;
		case "false":
		case "no":
		case "0":
		case "":
			return false;
		default:
			return Boolean(string);
	}
}

/**
 * @param  {ImportResults[]} results
 */
function summarizeImportResults(results) {
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

			// Accumulating for averaging later
			acc.eps += curr.eps;
			acc.mbps += curr.mbps;
			// ... handle other properties as needed

			return acc;
		},
		// @ts-ignore
		{
			success: 0,
			failed: 0,
			total: 0,
			eps: 0,
			mbps: 0,
			bytes: 0,
			duration: 0,
			rateLimit: 0,
			clientErrors: 0,
			serverErrors: 0,
		}
	);

	// Averaging properties
	const count = results.length;
	summary.eps /= count;
	summary.mbps /= count;
	// ... average other properties as needed

	return summary;
}
