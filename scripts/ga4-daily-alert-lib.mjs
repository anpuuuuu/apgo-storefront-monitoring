export function splitDailyAnomalies(anomalies, { defaultMode = 'observe', issueModes = {} } = {}) {
  const armed = [];
  const observed = [];
  for (const anomaly of anomalies || []) {
    const armedIssues = [];
    const observedIssues = [];
    for (const issue of anomaly.issues || []) {
      const mode = issueModes[issue] || defaultMode;
      (mode === 'armed' ? armedIssues : observedIssues).push(issue);
    }
    if (armedIssues.length) armed.push({ ...anomaly, issues: armedIssues });
    if (observedIssues.length) observed.push({ ...anomaly, issues: observedIssues });
  }
  return { armed, observed };
}

export function persistentDailyAnomalies(primary, confirmation) {
  const confirmed = new Map((confirmation || []).map((item) => [item.label, new Set(item.issues || [])]));
  return (primary || []).flatMap((item) => {
    const confirmedIssues = confirmed.get(item.label);
    if (!confirmedIssues) return [];
    const issues = (item.issues || []).filter((issue) => confirmedIssues.has(issue));
    return issues.length ? [{ ...item, issues }] : [];
  });
}
