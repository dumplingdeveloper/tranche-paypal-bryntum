import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byokProviderFromEnv, chooseAgent, clientOptionsFor } from '../../src/agent/copilot.ts';

test('BYOK env → SDK provider config (openai, anthropic, azure, ollama alias); no provider → Copilot login path', async () => {
  assert.equal(byokProviderFromEnv({}), undefined);
  assert.deepEqual(byokProviderFromEnv({ TRANCHE_LLM_PROVIDER: 'openai', TRANCHE_LLM_API_KEY: 'k' }), { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' });
  assert.deepEqual(byokProviderFromEnv({ TRANCHE_LLM_PROVIDER: 'anthropic', TRANCHE_LLM_API_KEY: 'k' }), { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k' });
  assert.deepEqual(byokProviderFromEnv({ TRANCHE_LLM_PROVIDER: 'Ollama' }), { type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: undefined });
  assert.throws(() => byokProviderFromEnv({ TRANCHE_LLM_PROVIDER: 'azure' }), /TRANCHE_LLM_BASE_URL is required for azure/);
  assert.deepEqual(byokProviderFromEnv({ TRANCHE_LLM_PROVIDER: 'azure', TRANCHE_LLM_BASE_URL: 'https://x.openai.azure.com', TRANCHE_AZURE_API_VERSION: '2024-10-21' }), { type: 'azure', baseUrl: 'https://x.openai.azure.com', apiKey: undefined, azure: { apiVersion: '2024-10-21' } });
  assert.throws(() => byokProviderFromEnv({ TRANCHE_LLM_PROVIDER: 'gemini' }), /must be openai, azure, anthropic or ollama/);
  await assert.rejects(chooseAgent({ TRANCHE_LLM_PROVIDER: 'openai', TRANCHE_LLM_API_KEY: 'k' }), /TRANCHE_LLM_MODEL is required/);
  assert.deepEqual(await chooseAgent({ TRANCHE_AGENT: 'scripted' }), { kind: 'scripted', reason: 'TRANCHE_AGENT=scripted' });
  // BYOK never uses the stored GitHub login and runs in an isolated, git-ignored COPILOT home.
  const byok = clientOptionsFor({ type: 'openai', baseUrl: 'http://127.0.0.1:1/v1' });
  assert.equal(byok.useLoggedInUser, false);
  assert.match(String(byok.baseDirectory), /artifacts\/runtime\/copilot-home$/);
  assert.equal(clientOptionsFor().useLoggedInUser, true);
});
