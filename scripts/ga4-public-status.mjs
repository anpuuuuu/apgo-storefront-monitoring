// GitHub Actions is public. Full financial reports belong in private D1 state,
// never in stdout, even during explicit diagnostics or Shadow runs.
export function revenueDiagnosticStatus(report) {
  const headers = (report.metricHeaders || []).map(({ name }) => name);
  if (!headers.length) throw new Error('GA4 diagnostic response has no metric headers');
  const positive = Object.fromEntries(headers.map((name) => [name, false]));
  for (const row of report.rows || []) {
    if (row.metricValues?.length !== headers.length) throw new Error('GA4 diagnostic metric shape is invalid');
    row.metricValues.forEach(({ value }, index) => {
      if (value === '' || !Number.isFinite(Number(value))) throw new Error('GA4 diagnostic contains a nonnumeric metric');
      positive[headers[index]] ||= Number(value) > 0;
    });
  }
  const restrictions = report.metadata?.schemaRestrictionResponse?.activeMetricRestrictions || [];
  return {
    metricAccess: restrictions.length ? 'restricted' : 'unrestricted',
    restrictedMetrics: restrictions.map(({ metricName, restrictedMetricTypes }) => ({ metricName, restrictedMetricTypes })),
    hasRows: (report.rows || []).length > 0,
    hasPositiveValues: positive,
    financialValuesSuppressed: true,
  };
}

export function dailyPublicStatus(summary) {
  return {
    ok: true,
    targetDate: summary.targetDate,
    stage: summary.stage,
    mode: summary.mode,
    generatedAt: summary.generatedAt,
    primaryGeneratedAt: summary.primaryGeneratedAt,
    baselineDates: summary.baselineDates,
    segmentCount: summary.segments.length,
    anomalyCount: summary.anomalies.length,
    persistentAnomalyCount: summary.persistent?.length || 0,
    dataQualityCodes: summary.dataQualityIssues.map(({ code }) => code),
    persistentDataQualityCodes: (summary.persistentDataQualityIssues || []).map(({ code }) => code),
    hasTransactions: summary.overall.transactions > 0,
    hasPurchaseRevenue: summary.overall.revenue > 0,
    financialValuesSuppressed: true,
  };
}
