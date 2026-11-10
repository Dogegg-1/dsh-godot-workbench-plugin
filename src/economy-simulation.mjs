import { fault } from './storage.mjs';

const RESOURCE_CAP = 1_000_000_000;
const MINER_CAP = 20;
const timeLabel = seconds => seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60 ? `${seconds % 60}秒` : '钟'}`;
function integer(value, low, high, name) {
  if (!Number.isSafeInteger(value) || value < low || value > high) throw fault('INVALID_SIMULATION', `${name}需要${low}–${high}之间的整数`);
}
// Explicit mining-incremental-v1 model, not an interpreter for arbitrary games.
// One tick: advance production, click, sell, then buy while affordable.
export function simulateMiningEconomy(values, options = {}) {
  const ranges = { click_yield: [1, 20], coin_per_ore: [1, 100], base_upgrade_cost: [1, 100000], miner_output: [1, 20] };
  for (const [key, [low, high]] of Object.entries(ranges)) integer(values?.[key], low, high, key);
  if (!Number.isFinite(values.upgrade_multiplier) || values.upgrade_multiplier < 1 || values.upgrade_multiplier > 3) throw fault('INVALID_SIMULATION', '涨价倍率需要在1–3之间');
  const { durationSeconds = 3600, clicksPerSecond = 1, stopClickingAtMiners = MINER_CAP + 1, sellEverySeconds = 1, buyEverySeconds = 1, sampleEverySeconds = 60 } = options;
  integer(durationSeconds, 1, 86400, '模拟时长'); integer(clicksPerSecond, 0, 20, '每秒点击次数');
  integer(stopClickingAtMiners, 0, MINER_CAP + 1, '停止点击时矿机数');
  integer(sellEverySeconds, 1, 3600, '出售间隔'); integer(buyEverySeconds, 1, 3600, '购买间隔'); integer(sampleEverySeconds, 1, 3600, '采样间隔');
  if (Math.ceil(durationSeconds / sampleEverySeconds) > 1440) throw fault('INVALID_SIMULATION', '曲线最多1440个区间，请增大采样间隔');
  const unknown = Object.keys(options).filter(k => !['durationSeconds', 'clicksPerSecond', 'stopClickingAtMiners', 'sellEverySeconds', 'buyEverySeconds', 'sampleEverySeconds'].includes(k));
  if (unknown.length) throw fault('INVALID_SIMULATION', `不支持的策略参数：${unknown.join('、')}`);
  let ore = 0, coins = 0, miners = 0, totalClicks = 0, totalEarned = 0, totalSpent = 0, discardedOre = 0;
  let lastPurchaseAt = 0, ceilingAt = null, priceBlockedAt = null, incomeTenfoldAt = null, firstIncome = null;
  const purchases = [], curve = [];
  const cost = () => Math.ceil(values.base_upgrade_cost * values.upgrade_multiplier ** miners);
  const snapshot = second => ({ second, ore, coins, miners, coinsPerSecond: miners * values.miner_output * values.coin_per_ore, totalEarned, totalSpent });
  const addOre = amount => { const next = ore + amount; discardedOre += Math.max(0, next - RESOURCE_CAP); ore = Math.min(next, RESOURCE_CAP); };
  curve.push(snapshot(0));
  for (let second = 1; second <= durationSeconds; second++) {
    addOre(miners * values.miner_output);
    if (miners < stopClickingAtMiners) { addOre(clicksPerSecond * values.click_yield); totalClicks += clicksPerSecond; }
    if (second % sellEverySeconds === 0) {
      const sold = Math.min(ore, Math.floor((RESOURCE_CAP - coins) / values.coin_per_ore));
      const earned = sold * values.coin_per_ore;
      ore -= sold; coins += earned; totalEarned += earned;
    }
    if (second % buyEverySeconds === 0) {
      while (miners < MINER_CAP && coins >= cost()) {
        const price = cost(); coins -= price; totalSpent += price; miners++;
        purchases.push({ level: miners, second, cost: price, waitSeconds: second - lastPurchaseAt, coinsAfter: coins }); lastPurchaseAt = second;
        if (firstIncome === null) firstIncome = miners * values.miner_output * values.coin_per_ore;
      }
    }
    if (miners === MINER_CAP && ceilingAt === null) ceilingAt = second;
    if (miners < MINER_CAP && cost() > RESOURCE_CAP && priceBlockedAt === null) priceBlockedAt = second;
    if (firstIncome !== null && miners * values.miner_output * values.coin_per_ore >= firstIncome * 10 && incomeTenfoldAt === null) incomeTenfoldAt = second;
    if (second % sampleEverySeconds === 0 || second === durationSeconds) curve.push(snapshot(second));
  }
  const longest = purchases.reduce((best, item) => !best || item.waitSeconds > best.waitSeconds ? item : best, null);
  const remainingWait = miners < MINER_CAP ? { fromLevel: miners, observedSeconds: durationSeconds - lastPurchaseAt, completed: false } : null;
  const addedCoinsPerSecond = values.miner_output * values.coin_per_ore;
  const simplePayback = {
    addedCoinsPerSecond,
    firstPurchase: purchases.length ? { level: purchases[0].level, seconds: purchases[0].cost / addedCoinsPerSecond } : null,
    lastPurchase: purchases.length ? { level: purchases.at(-1).level, seconds: purchases.at(-1).cost / addedCoinsPerSecond } : null,
    definition: '单次购买价格÷这一台新增的每秒金币产出。仅为连续出售下的静态回本估计，不是购买等待；不含已有矿机、点击、后续再投资或容量限制。只列本次已购买的首台与末台，不能推断其他档位相近。',
  };
  let conclusion = longest ? `已完成的购买中，第${longest.level}台前等待最长，为${timeLabel(longest.waitSeconds)}。` : `模拟${timeLabel(durationSeconds)}，仍未买到第一台矿机。`;
  if (priceBlockedAt !== null) conclusion += `第${miners + 1}台价格超过金币上限，在这些规则下无法购买。`;
  else if (ceilingAt !== null) conclusion += `第${ceilingAt}秒达到${MINER_CAP}台上限，后续没有矿机可买。`;
  else if (purchases.length && remainingWait?.observedSeconds) conclusion += `末次购买后又经过${timeLabel(remainingWait.observedSeconds)}仍未升级，这段等待尚未结束。`;
  return {
    model: 'mining-incremental-v1', rules: { ...values, resourceCap: RESOURCE_CAP, minerCap: MINER_CAP },
    strategy: { durationSeconds, clicksPerSecond, stopClickingAtMiners, sellEverySeconds, buyEverySeconds, sampleEverySeconds },
    conclusion, final: snapshot(durationSeconds), purchases, curve, longestCompletedWait: longest, remainingWait, simplePayback,
    ceilingAt, priceBlockedAt, incomeTenfoldAt, totalClicks, discardedOre,
    boundary: '每秒先产矿、再点击、出售、连续购买。收入十倍仅是观察点，不代表失衡；模拟不包含操作耗时、暂停、离线收益或玩家行为变化，不能替代真实工程核对与试玩。',
  };
}
