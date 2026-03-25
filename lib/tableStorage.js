/**
 * Table Storage helper for storing Teams message IDs.
 *
 * Stores messageId per meeting so "completed" notification can update
 * the "started" card in the meeting group chat.
 *
 * Table: TeamsMessages
 * PartitionKey: "meeting"
 * RowKey: "{meetingId}-{transcriptId}" (or executionId)
 * Fields: messageId, chatId, timestamp
 *
 * Required Environment Variables:
 *   STORAGE_CONNECTION_STRING - Azure Storage connection string
 */

const TABLE_NAME = "TeamsMessages";

let tableClient = null;

function log(level, message, data = null) {
  const logEntry = {
    level: level.toLowerCase(),
    message,
    ...(data && { ...data }),
  };
  console.error(JSON.stringify(logEntry));
}

async function getTableClient() {
  if (tableClient) return tableClient;

  const connectionString = process.env.STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error("STORAGE_CONNECTION_STRING is required for Table Storage");
  }

  const { TableClient } = require("@azure/data-tables");
  tableClient = TableClient.fromConnectionString(connectionString, TABLE_NAME);

  // Create table if it doesn't exist (idempotent)
  await tableClient.createTable().catch((err) => {
    // TableAlreadyExists is fine
    if (err.statusCode !== 409) throw err;
  });

  return tableClient;
}

/**
 * Store a messageId for a meeting execution.
 * @param {string} executionKey - Unique key (e.g. executionId or meetingId-transcriptId)
 * @param {string} messageId - Teams message ID returned by Logic App
 * @param {string} chatId - Meeting group chat thread ID
 */
async function storeMessageId(executionKey, messageId, chatId) {
  const client = await getTableClient();
  const entity = {
    partitionKey: "meeting",
    rowKey: executionKey,
    messageId,
    chatId,
    timestamp: new Date().toISOString(),
  };

  await client.upsertEntity(entity, "Replace");
  log("debug", "Stored messageId in Table Storage", {
    executionKey,
    messageId,
  });
}

/**
 * Retrieve a stored messageId for a meeting execution.
 * @param {string} executionKey - Unique key used when storing
 * @returns {{ messageId: string, chatId: string } | null}
 */
async function getMessageId(executionKey) {
  const client = await getTableClient();
  try {
    const entity = await client.getEntity("meeting", executionKey);
    return {
      messageId: entity.messageId,
      chatId: entity.chatId,
    };
  } catch (err) {
    if (err.statusCode === 404) {
      log("debug", "No messageId found in Table Storage", { executionKey });
      return null;
    }
    throw err;
  }
}

/**
 * Delete a stored messageId entry.
 * @param {string} executionKey - Unique key used when storing
 */
async function deleteMessageId(executionKey) {
  const client = await getTableClient();
  try {
    await client.deleteEntity("meeting", executionKey);
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
}

module.exports = {
  storeMessageId,
  getMessageId,
  deleteMessageId,
  TABLE_NAME,
};
