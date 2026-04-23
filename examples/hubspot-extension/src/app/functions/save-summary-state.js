const hubspot = require("@hubspot/api-client");

const FIELD_MAP = {
  streamId: "ai_summary_stream_id",
  offset: "ai_summary_stream_offset",
  summary: "ai_summary_text",
};

exports.main = async function main(context = {}) {
  const accessToken = context.secrets?.PRIVATE_APP_ACCESS_TOKEN || process.env.PRIVATE_APP_ACCESS_TOKEN;
  const contactId = context.parameters?.contactId;

  if (!accessToken) {
    throw new Error("Missing PRIVATE_APP_ACCESS_TOKEN secret");
  }

  if (!contactId) {
    throw new Error("Missing contactId parameter");
  }

  const properties = {};

  for (const [parameterName, propertyName] of Object.entries(FIELD_MAP)) {
    if (Object.prototype.hasOwnProperty.call(context.parameters, parameterName)) {
      const value = context.parameters[parameterName];
      properties[propertyName] = value === null || value === undefined ? "" : String(value);
    }
  }

  if (Object.keys(properties).length === 0) {
    return { success: true, updated: [] };
  }

  const client = new hubspot.Client({ accessToken });
  await client.crm.contacts.basicApi.update(String(contactId), { properties });

  return {
    success: true,
    updated: Object.keys(properties),
  };
};
