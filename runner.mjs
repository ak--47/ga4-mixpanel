import { EXTRACT_JOB, LOAD_JOB} from './index.js'

// const extractResults = await EXTRACT_JOB(process.env.BQ_TABLE_ID);
const results = await LOAD_JOB('gs://mixpanel_prod/2023-12-24-16:13-tempFile-000000000000.jsonl')
debugger;