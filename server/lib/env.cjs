const { z } = require('zod');
const dotenv = require('dotenv');

dotenv.config();

const envSchema = z.object({
  SNOWFLAKE_ACCOUNT: z.string().min(1),
  SNOWFLAKE_USER: z.string().min(1),
  SNOWFLAKE_PASSWORD: z.string().min(1),
  SNOWFLAKE_ROLE: z.string().min(1),
  SNOWFLAKE_WAREHOUSE: z.string().min(1),
  SNOWFLAKE_DATABASE: z.string().min(1),
  SNOWFLAKE_SCHEMA: z.string().min(1),
  SNOWFLAKE_STAGE: z.string().min(1),
  CORTEX_EMBED_MODEL: z.string().min(1).default('snowflake-arctic-embed-m'),
  CORTEX_LLM_MODEL: z.string().min(1).default('snowflake-arctic'),
  VECTOR_DIM: z.coerce.number().int().positive().default(768),
  CHUNK_SIZE: z.coerce.number().int().positive().default(1200),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().max(1000).default(200),
});

const env = envSchema.parse(process.env);

const stageRef = env.SNOWFLAKE_STAGE.trim();
const stageName = stageRef.startsWith('@') ? stageRef.slice(1) : stageRef;
const STAGE_REFERENCE = stageRef.startsWith('@') ? stageRef : `@${stageRef}`;
const STAGE_NAME = stageName;
const TABLE_DOCUMENTS = `${env.SNOWFLAKE_DATABASE}.${env.SNOWFLAKE_SCHEMA}.PDF_DOCUMENTS`;
const TABLE_VECTORS = `${env.SNOWFLAKE_DATABASE}.${env.SNOWFLAKE_SCHEMA}.PDF_VECTORS`;

module.exports = {
  env,
  STAGE_REFERENCE,
  STAGE_NAME,
  TABLE_DOCUMENTS,
  TABLE_VECTORS,
};
