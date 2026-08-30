import fs from 'node:fs';
import path from 'node:path';

export function journeyWritesCart(journey) {
  return journey?.writesCart === true || journey?.mode === 'full';
}

export function readJourneyResult(artifacts) {
  const file = path.join(artifacts, 'layer2-result.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function opensRateLimitCircuit(result) {
  return result?.finalStatus === 'failed' && result?.classification === 'MONITOR_RATE_LIMIT';
}

export function writeCircuitBreakerResult(artifacts, journey, detail = 'A previous write journey was persistently rate limited') {
  fs.mkdirSync(artifacts, { recursive: true });
  const now = new Date().toISOString();
  const result = {
    id: journey.id,
    site: journey.site || '',
    market: journey.market || '',
    device: journey.device || '',
    journey: journey.journey || '',
    suite: journey.suite || '',
    landingPath: journey.landingPath || '',
    channel: journey.channel || '',
    commit: process.env.MONITOR_COMMIT || '',
    finalStatus: 'failed',
    classification: 'MONITOR_RATE_LIMIT',
    attempts: [{
      attempt: 0,
      startedAt: now,
      finishedAt: now,
      exitCode: 1,
      status: 'failed',
      classification: 'MONITOR_RATE_LIMIT',
      error: `MONITOR_RATE_LIMIT: circuit breaker skipped this cart write. ${detail}`,
    }],
  };
  fs.writeFileSync(path.join(artifacts, 'layer2-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
