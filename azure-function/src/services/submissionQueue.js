const { QueueClient } = require("@azure/storage-queue");

const DEFAULT_QUEUE = "transcript-notifications";

function createSubmissionQueue({ connectionString, queueName = DEFAULT_QUEUE } = {}) {
  const resolvedConnection = connectionString || process.env.AzureWebJobsStorage;
  if (!resolvedConnection) throw new Error("AzureWebJobsStorage is not configured");
  const queue = new QueueClient(resolvedConnection, queueName);
  return {
    async publish(message) {
      await queue.sendMessage(Buffer.from(JSON.stringify(message), "utf8").toString("base64"));
    },
  };
}

module.exports = { DEFAULT_QUEUE, createSubmissionQueue };
