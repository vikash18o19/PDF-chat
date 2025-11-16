const snowflake = require('snowflake-sdk');
const { env, STAGE_REFERENCE, STAGE_NAME, TABLE_DOCUMENTS, TABLE_VECTORS } = require('./env.cjs');

const connectionConfig = {
  account: env.SNOWFLAKE_ACCOUNT,
  username: env.SNOWFLAKE_USER,
  password: env.SNOWFLAKE_PASSWORD,
  role: env.SNOWFLAKE_ROLE,
  warehouse: env.SNOWFLAKE_WAREHOUSE,
  database: env.SNOWFLAKE_DATABASE,
  schema: env.SNOWFLAKE_SCHEMA,
};

const connect = () =>
  new Promise((resolve, reject) => {
    const connection = snowflake.createConnection(connectionConfig);
    connection.connect((err, conn) => {
      if (err) {
        reject(err);
      } else {
        resolve(conn);
      }
    });
  });

const execute = (connection, options) =>
  new Promise((resolve, reject) => {
    connection.execute({
      ...options,
      complete: (err, stmt, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      },
    });
  });

let infrastructureReady = false;

const ensureVectorColumnShape = async (connection) => {
  const rows = await execute(connection, {
    sqlText: `
      select data_type
      from information_schema.columns
      where table_catalog = ?
        and table_schema = ?
        and table_name = 'PDF_VECTORS'
        and column_name = 'EMBEDDING'
    `,
    binds: [env.SNOWFLAKE_DATABASE.toUpperCase(), env.SNOWFLAKE_SCHEMA.toUpperCase()],
  });

  if (!rows?.length) {
    return;
  }

  const expected = `VECTOR(FLOAT, ${env.VECTOR_DIM})`;
  const currentType = rows[0].DATA_TYPE;
  if (typeof currentType === 'string' && currentType.toUpperCase() !== expected) {
    await execute(connection, {
      sqlText: `alter table ${TABLE_VECTORS} alter column EMBEDDING set data type vector(float, ${env.VECTOR_DIM})`,
    });
  }
};

const ensureDocumentsTableShape = async (connection) => {
  await execute(connection, { sqlText: `create table if not exists ${TABLE_DOCUMENTS} (
    FILE_ID string,
    FILENAME string,
    STAGE_PATH string,
    CHUNK_COUNT number,
    METADATA variant,
    CREATED_AT timestamp_ltz
  )` });

  await execute(connection, {
    sqlText: `alter table ${TABLE_DOCUMENTS} add column if not exists CREATED_AT timestamp_ltz`,
  });
  await execute(connection, {
    sqlText: `alter table ${TABLE_DOCUMENTS} add column if not exists METADATA variant`,
  });
};

const ensureVectorsTableShape = async (connection) => {
  await execute(connection, { sqlText: `create table if not exists ${TABLE_VECTORS} (
    CHUNK_ID string,
    FILE_ID string,
    PAGE_NUMBER number,
    CHUNK_INDEX number,
    CHUNK_TEXT string,
    CHAR_START number,
    CHAR_END number,
    SOURCE_META variant,
    EMBEDDING vector(float, ${env.VECTOR_DIM}),
    CREATED_AT timestamp_ltz
  )` });

  await execute(connection, {
    sqlText: `alter table ${TABLE_VECTORS} add column if not exists CHAR_START number`,
  });
  await execute(connection, {
    sqlText: `alter table ${TABLE_VECTORS} add column if not exists CHAR_END number`,
  });
  await execute(connection, {
    sqlText: `alter table ${TABLE_VECTORS} add column if not exists SOURCE_META variant`,
  });
  await execute(connection, {
    sqlText: `alter table ${TABLE_VECTORS} add column if not exists CREATED_AT timestamp_ltz`,
  });
};

const ensureInfrastructure = async (connection) => {
  if (infrastructureReady) {
    return;
  }

  await execute(connection, { sqlText: `create stage if not exists ${STAGE_NAME}` });
  await ensureDocumentsTableShape(connection);
  await ensureVectorsTableShape(connection);
  await ensureVectorColumnShape(connection);
  infrastructureReady = true;
};

const withSnowflakeConnection = async (handler) => {
  const connection = await connect();
  try {
    await ensureInfrastructure(connection);
    return await handler(connection);
  } finally {
    await new Promise((resolve) => {
      connection.destroy((err) => {
        if (err) {
          console.error('Failed to release Snowflake connection', err);
        }
        resolve();
      });
    });
  }
};

const runQuery = async (sqlText, binds = []) =>
  withSnowflakeConnection((connection) => execute(connection, { sqlText, binds }));

module.exports = {
  connectionConfig,
  execute,
  runQuery,
  withSnowflakeConnection,
  ensureInfrastructure,
  STAGE_REFERENCE,
  STAGE_NAME,
  TABLE_DOCUMENTS,
  TABLE_VECTORS,
};
