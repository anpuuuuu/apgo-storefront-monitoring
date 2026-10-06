/* What the owner reads when the Layer 2 browser journeys fail.

   2026-10-06 the Layer 2 message read, in full:
     journeys failed=1, missing=0; apgo-my-MY-android-chromium-ad-2c393cbeae
     Paid Social /products/pocket-friendly-deals [storefront_failure]: #1
     storefront_failure: Error: [2mexpect( [22m [31mlocator [39m [2m). [22m…
   — test-runner output with terminal colour codes, cut off mid-word, and a
   classification that said the storefront had failed when it had not.

   This prepares the message as data for workflow-failure-notify.mjs, which
   formats and sends it. Layer 2 is never red: its contract checks can fail
   when the theme changes on purpose, as they did that day, so a failure here
   asks for a look rather than an immediate response. The ringing signals for
   "customers cannot buy" are Layer 1, the checkout watch and the order
   heartbeat. */

const DEVICE_WORDS = {
  'android-chromium': '安卓手机',
  'iphone-webkit': 'iPhone',
  'desktop-chromium': '电脑',
  'facebook-android': '安卓手机的 Facebook 内置浏览器',
  'instagram-iphone': 'iPhone 的 Instagram 内置浏览器',
};

export function deviceWords(device) {
  return DEVICE_WORDS[device] || device || '某台设备';
}

function journeyLine(result) {
  const sessions = Number(result.advertising?.sessions || 0);
  return `· ${deviceWords(result.device)}：${result.landingPath || '/'}${sessions ? `（广告落地页，3 天 ${sessions} 次访问）` : ''}`;
}

function journeyDetail(result) {
  const last = (result.attempts || []).at(-1);
  return `${result.id} [${result.classification}] ${String(last?.error || '').slice(0, 220)}`;
}

/* Returns the prepared message, or null when there is nothing to say. */
export function layer2Alert({ cancelled = false, planningFailed = false, planError = '', missing = [], failed = [], site = '' } = {}) {
  if (cancelled) return null;

  if (planningFailed) {
    const discovery = String(planError).includes('AD_DISCOVERY_FAILED');
    return {
      level: 'watch',
      title: discovery ? '购物流程测试没法开始：读不到广告页面' : '购物流程测试没法开始',
      site,
      store: '这次没测到',
      lines: [discovery
        ? '测试要先从 GA4 读出广告在投哪些页面，这一步失败了，所以今天没有测。店铺本身仍有第 1 层和结账探测看着。'
        : '测试在准备阶段就出错了，所以今天没有测。店铺本身仍有第 1 层和结账探测看着。'],
      details: [planError],
    };
  }

  const classes = new Set(failed.map((result) => result.classification));
  const only = (name) => classes.size === 1 && classes.has(name);

  if (!failed.length && missing.length) {
    return {
      level: 'watch',
      title: '购物流程测试有部分没跑完',
      site,
      store: '这次没测完整',
      lines: [`有 ${missing.length} 条测试没有回报结果，可能是测试机器中途出错。其余的测试都通过了。`],
      details: missing.slice(0, 6),
    };
  }

  if (only('MONITOR_RATE_LIMIT')) {
    return {
      level: 'ignore',
      title: '购物流程测试被 Shopify 限流了',
      site,
      store: '店铺多半正常',
      lines: ['是 Shopify 在限制测试机器人，不是顾客买不了。明天会再测。'],
      details: failed.map(journeyDetail),
    };
  }

  if (only('MONITOR_ACCESS_CHALLENGE')) {
    return {
      level: 'ignore',
      title: '购物流程测试被网站防护挡住了',
      site,
      store: '店铺多半正常',
      lines: ['测试机器人被当成可疑流量挡了下来，一般顾客不受影响。明天会再测。'],
      details: failed.map(journeyDetail),
    };
  }

  if (only('TEST_CONFIG_STALE')) {
    return {
      level: 'watch',
      title: '购物流程测试的设置过期了',
      site,
      store: '店铺多半正常',
      lines: ['测试要找的商品或按钮在网站上找不到了，通常是活动结束或页面改版。多半是测试要更新，不是店坏了。', ...failed.slice(0, 4).map(journeyLine)],
      details: failed.map(journeyDetail),
    };
  }

  const shown = failed.slice(0, 4);
  const single = failed.length === 1 ? failed[0] : null;
  return {
    level: 'watch',
    title: single
      ? `${deviceWords(single.device)}上「${single.landingPath || '/'}」的购物测试没通过`
      : `${failed.length} 条购物流程测试没通过`,
    site,
    store: '店铺可能有问题',
    lines: [
      '测试机器人在这些页面没走通购物流程，隔一分钟重试一次也一样：',
      ...shown.map(journeyLine),
      failed.length > shown.length ? `· 还有 ${failed.length - shown.length} 条，见技术细节` : '',
      '请用手机打开上面的页面，自己试一次加入购物车。如果你能顺利加进去，多半是网站改版后测试没跟上，告诉我来修测试。',
      missing.length ? `另有 ${missing.length} 条测试没有回报结果。` : '',
    ],
    details: failed.map(journeyDetail),
  };
}
