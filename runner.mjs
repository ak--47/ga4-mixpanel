import { EXTRACT, LOAD} from './index.js'

const extractResults = await EXTRACT(process.env.BQ_TABLE_ID);
const results = await LOAD('gs://bucket/file.jsonl')
debugger;