import functions from "@google-cloud/functions-framework";
import { BigQuery } from '@google-cloud/bigquery';
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import Mixpanel from 'mixpanel-import';
import pLimit from 'p-limit';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { parseGCSUri, sLog, timer, isNil } from 'ak-tools';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
dayjs.extend(utc);
import dotenv from 'dotenv';
dotenv.config();


const GCP_PROJECT = process.env.GCP_PROJECT;
const BQ_DATASET_ID = process.env.BQ_DATASET_ID;
const GCS_BUCKET = process.env.GCS_BUCKET;
const MP_TOKEN = process.env.MP_TOKEN;
const MP_SECRET = process.env.MP_SECRET;
const MP_PROJECT = process.env.MP_PROJECT;

if (!GCP_PROJECT) throw new Error('GCP_PROJECT is required');
if (!BQ_DATASET_ID) throw new Error('BQ_DATASET_ID is required');
if (!GCS_BUCKET) throw new Error('GCS_BUCKET is required');
if (!MP_TOKEN && !MP_SECRET) throw new Error('MP_TOKEN or MP_SECRET is required');

// <-- TODO: make this dynamic ?!?!?
const URL = process.env.URL || `https://ga4-mixpanel-lmozz6xkha-uc.a.run.app`;

const dateLabelLong = dayjs.utc().format('YYYY-MM-DD-HH:mm');
const dateLabelShort = dayjs.utc().format('YYYYMMDD');
const fileName = `${dateLabelLong}-tempFile-`;
const bigquery = new BigQuery({ projectId: GCP_PROJECT });
const storage = new Storage({ projectId: GCP_PROJECT });

//MIGHT CHANGE
let BQ_TABLE_ID = process.env.BQ_TABLE_ID;
let CONCURRENCY = process.env.CONCURRENCY || 30;
let INTRADAY = process.env.INTRADAY || true;
let DATE = process.env.DATE || dateLabelShort;
let LOOKBACK = process.env.LOOKBACK || 3600;
let LATE = process.env.LATE || 60;



/** @type {import('mixpanel-import').Creds} */
const creds = {};
if (MP_TOKEN) creds.token = MP_TOKEN;
if (MP_SECRET) creds.secret = MP_SECRET;
if (MP_PROJECT) creds.project = MP_PROJECT;

/** @type {import('mixpanel-import').Options} */
const opts = {
	vendor: "ga4",
	recordType: "event",
	abridged: true,
	streamFormat: "jsonl",
	strict: false,
	verbose: false,
	workers: 10,
	compress: false,
	dryRun: false,
	flattenData: true,
};


functions.http('go', async (req, res) => {
	try {
		// GET REQUESTS EXTRACT DATA
		if (req.method === 'GET') {

			//if provided, use query params, otherwise use env vars		
			BQ_TABLE_ID = req.query.table || BQ_TABLE_ID;
			LOOKBACK = req.query.lookback ? Number(req.query.lookback) : LOOKBACK;
			LATE = req.query.late ? Number(req.query.late) : LATE;
			INTRADAY = !isNil(req.query.intraday) ? stringToBoolean(req.query.intraday) : INTRADAY;
			DATE = req.query.date ? dayjs(req.query.date).format('YYYYMMDD') : DATE;
			CONCURRENCY = req.query.concurrency ? Number(req.query.CONCURRENCY) : CONCURRENCY;

			if (!BQ_TABLE_ID) BQ_TABLE_ID = `events_${DATE}`; //date = today if not specified
			sLog('SYNC START', { BQ_TABLE_ID, LOOKBACK, LATE, INTRADAY, DATE, CONCURRENCY });
			const extractResult = await EXTRACT();

			res.status(200).send(extractResult);
			return;
		}

		// POST REQUESTS LOAD DATA
		if (req.method === 'POST' && req.body && req.body.file) {
			const loadResult = await LOAD(req.body.file);
			res.status(200).send(loadResult);
			return;
		}

		res.status(400).send('Bad Request; expecting GET to extract or POST with file to load');
		return;

	} catch (err) {
		sLog("Bad Path", req, "CRITICAL")
		res.status(500).send({ error: err.message }); // Send back a JSON error message
	}
});


/*
----
EXTRACT
----
*/

export async function EXTRACT() {
	const watch = timer('SYNC');
	watch.start();
	try {
		const query = buildSQLQuery(BQ_TABLE_ID, INTRADAY, LOOKBACK, LATE);
		sLog(`RUNNING QUERY:`, { query });
		const uris = await exportQueryResultToGCS(BQ_TABLE_ID, query);
		const tasks = await loadGCSToMixpanel(uris);

		sLog(`SYNC COMPLETE: ${watch.end()}`, uris);
		return { uris, ...tasks };

	} catch (error) {
		sLog(`SYNC FAIL: ${watch.end()}`, { error: error.message }, 'CRITICAL');
		throw error;
	}
}

function buildSQLQuery(TABLE_ID, intraDay = false, lookBackWindow = 3600, late = 60) {
	// i.e. intraday vs full day
	// .events_intraday_*
	// .events_*  or .events_20231222
	let query = `SELECT * FROM \`${GCP_PROJECT}.${BQ_DATASET_ID}.`;
	if (intraDay) query += `events_intraday_*\``;
	if (intraDay) query += `\nWHERE\nTIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(CAST(event_timestamp / 1000 as INT64)), SECOND) <= ${lookBackWindow} `;
	if (intraDay) query += `\nOR\n(event_server_timestamp_offset > ${late * 1000000} AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(CAST(event_timestamp / 1000 as INT64)), SECOND) <= ${lookBackWindow * 2})`;
	if (!intraDay) query += `${TABLE_ID}\``;
	return query;
}

export async function exportQueryResultToGCS(BQ_TABLE_ID) {
	const watch = timer('bigquery');
	watch.start();
	const query = buildSQLQuery(BQ_TABLE_ID);
	const jobConfig = {
		query,
		location: 'US', // Change this to match your dataset's location
		destination: null, // This creates a temporary table for query results
		writeDisposition: 'WRITE_TRUNCATE', // Overwrites the table if it already exists
	};

	const [job] = await bigquery.createQueryJob(jobConfig);
	await pollJob(job);

	const destinationTable = job.metadata.configuration.query.destinationTable;
	const destination = storage.bucket(GCS_BUCKET).file(fileName.concat('*.jsonl'));

	// Create a job to export the data from the temporary table to GCS
	const [exportJob] = await bigquery
		.dataset(destinationTable.datasetId)
		.table(destinationTable.tableId)
		.extract(destination, { format: 'JSON', gzip: false });

	const [files] = await storage.bucket(GCS_BUCKET).getFiles({ "prefix": fileName });
	const uris = files.map(file => `gs://${GCS_BUCKET}/${file.name}`);


	sLog(`BIGQUERY EXPORT: ${watch.end()}`, exportJob);

	return uris;
}

async function pollJob(job) {
	// Poll the job status without fetching the query result rows
	let jobMetadata;
	do {
		await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds delay
		[jobMetadata] = await job.getMetadata();
	} while (jobMetadata.status.state !== 'DONE');

	if (jobMetadata.status.errorResult) {
		throw new Error(`Job failed with error ${jobMetadata.status.errorResult.message}`);
	}
}

async function makeRequest(client, uri) {
	try {
		await client.request({
			url: URL,
			method: 'POST',
			data: { file: uri },
			headers: {
				'Content-Type': 'application/json',
			},
			retryConfig: {
				retry: 10,
				statusCodesToRetry: [
					[100, 199],
					[400, 499],
					[500, 599]
				]
			}
		});
		return true;
	} catch (error) {
		sLog(`Error triggering function for ${uri}:`, error, "ERROR");
		return false;
	}
};

async function loadGCSToMixpanel(uris) {
	const auth = new GoogleAuth();
	const client = await auth.getIdTokenClient(URL);
	const limit = pLimit(CONCURRENCY);
	const requestPromises = uris.map(uri => limit(() => makeRequest(client, uri)));
	const complete = await Promise.allSettled(requestPromises);
	const results = {
		success: complete.filter(p => p.status === 'fulfilled').length,
		failed: complete.filter(p => p.status === 'rejected').length
	};
	results.total = results.success + results.failed;
	results.successRate = results.success / results.total;
	return results;
}



/*
----
LOAD
----
*/

export async function LOAD(file) {
	const watch = timer('LOAD');
	watch.start();
	try {
		const importJob = await GCStoMixpanel(file);
		sLog(`LOAD ${parseGCSUri(file).file}: ${watch.end()}`, importJob, 'DEBUG');
		return importJob;
	} catch (error) {
		sLog(`LOAD FAIL: ${watch.end()}`, error, "ERROR");
		throw error;
	}
}


async function GCStoMixpanel(filePath) {
	const { bucket, file, uri } = parseGCSUri(filePath);
	const data = await storage.bucket(bucket).file(file);
	const localFilePath = path.join(os.tmpdir(), file.name);

	try {
		const watch = timer('file');
		watch.start();
		// Download file to a temporary location
		await data.download({ destination: localFilePath, validation: false });

		// Pass the file to Mixpanel
		const result = await Mixpanel(creds, localFilePath, opts);

		// Delete the file from temporary storage
		fs.unlinkSync(localFilePath);

		// Delete the file from GCS
		await file.delete();
		return result;

	} catch (error) {
		sLog('Error processing file:', {file: file.name, error: error}, 'ERROR');
		throw error;
	}
}




function stringToBoolean(string) {
	if (typeof string !== 'string') {
		return Boolean(string);
	}

	switch (string.toLowerCase().trim()) {
		case 'true': case 'yes': case '1': return true;
		case 'false': case 'no': case '0': case '': return false;
		default: return Boolean(string);
	}
}
