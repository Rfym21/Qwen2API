const SUPPORTED_FIELDS = new Set([
  'model',
  'messages',
  'stream'
]);

const PARTIAL_FIELDS = new Set([
  'system',
  'tools',
  'tool_choice',
  'thinking'
]);

const IGNORED_WITH_WARNING_FIELDS = new Set([
  'max_tokens',
  'stop_sequences',
  'metadata',
  'temperature',
  'top_p',
  'top_k',
  'service_tier',
  'container',
  'output_config',
  'cache_control'
]);

const FUTURE_RISK_FIELDS = new Set([
  'mcp_servers',
  'context_management'
]);

const analyzeAnthropicCompatibility = (requestBody = {}) => {
  const keys = Object.keys(requestBody || {});
  const supportedFields = [];
  const partialFields = [];
  const ignoredFields = [];
  const futureRiskFields = [];

  for (const key of keys) {
    if (SUPPORTED_FIELDS.has(key)) {
      supportedFields.push(key);
    } else if (PARTIAL_FIELDS.has(key)) {
      partialFields.push(key);
    } else if (IGNORED_WITH_WARNING_FIELDS.has(key)) {
      ignoredFields.push(key);
    } else if (FUTURE_RISK_FIELDS.has(key)) {
      futureRiskFields.push(key);
    }
  }

  const summaryParts = [];
  if (partialFields.length > 0) {
    summaryParts.push(`partial=${partialFields.join(',')}`);
  }
  if (ignoredFields.length > 0) {
    summaryParts.push(`ignored=${ignoredFields.join(',')}`);
  }
  if (futureRiskFields.length > 0) {
    summaryParts.push(`future_risk=${futureRiskFields.join(',')}`);
  }

  return {
    supportedFields,
    partialFields,
    ignoredFields,
    futureRiskFields,
    summary: summaryParts.join(';')
  };
};

const buildAnthropicCompatibilityHeaders = ({ partialFields = [], ignoredFields = [], futureRiskFields = [] } = {}) => {
  const headers = {};

  if (partialFields.length > 0 || futureRiskFields.length > 0) {
    const compatibilityParts = [];
    if (partialFields.length > 0) {
      compatibilityParts.push(`partial=${partialFields.join(',')}`);
    }
    if (futureRiskFields.length > 0) {
      compatibilityParts.push(`future_risk=${futureRiskFields.join(',')}`);
    }
    headers['X-Qwen2API-Anthropic-Compatibility'] = compatibilityParts.join(';');
  }

  if (ignoredFields.length > 0) {
    headers['X-Qwen2API-Anthropic-Warnings'] = `ignored=${ignoredFields.join(',')}`;
  }

  return headers;
};

module.exports = {
  analyzeAnthropicCompatibility,
  buildAnthropicCompatibilityHeaders
};
