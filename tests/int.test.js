// @ts-nocheck
import { BigQuery } from "@google-cloud/bigquery";
import { Storage } from "@google-cloud/storage";
import { BACKFILL_PATCH, LOAD_POST, EXTRACT_GET, STORAGE_DELETE } from "../index";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
dayjs.extend(utc);
import dotenv from "dotenv";
dotenv.config({ override: true, path: '.env.tests'});

let { BQ_DATASET_ID, BQ_TABLE_ID, GCS_BUCKET, MP_TOKEN, INTRADAY, NUM_ROWS, MP_SECRET } = process.env;

NUM_ROWS = parseInt(NUM_ROWS);
INTRADAY = stringToBoolean(INTRADAY);


describe('extract job', () => {
	//todo
});

describe('load job', () => {
	//todo
});

