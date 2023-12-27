import { EXTRACT_JOB, LOAD_JOB} from './index.js'

// const extractResults = await EXTRACT_JOB(process.env.BQ_TABLE_ID);
const results = await EXTRACT_JOB(false)
debugger;