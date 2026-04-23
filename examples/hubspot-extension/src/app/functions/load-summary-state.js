const hubspot = require("@hubspot/api-client");

const PROPERTIES = [
  "ai_summary_stream_id",
  "ai_summary_stream_offset",
  "ai_summary_text",
];

exports.main = async function main(context = {}) {
  const accessToken = context.secrets?.PRIVATE_APP_ACCESS_TOKEN || process.env.PRIVATE_APP_ACCESS_TOKEN;
  const contactId = context.parameters?.contactId;

  if (!accessToken) {
    throw new Error("Missing PRIVATE_APP_ACCESS_TOKEN secret");
  }

  if (!contactId) {
    throw new Error("Missing contactId parameter");
  }

  const client = new hubspot.Client({ accessToken });
  const contact = await client.crm.contacts.basicApi.getById(
    String(contactId),
    PROPERTIES
  );

  return {
    properties: contact.properties || {},
  };
};
