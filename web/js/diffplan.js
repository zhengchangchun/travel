/* 增量渲染计划：比较「上一屏的键」与「这一屏的键」，算出保留/新增/移除
   纯函数（可单测）：列表与地图旗子都走同一套口径，避免整屏重建 */
(function () {
  // oldKeys/newKeys: 字符串数组（顺序＝渲染顺序）
  // 返回 {keep,add,remove,order}：keep＝两边都有的键，add＝新出现的，remove＝消失的
  function planDiff(oldKeys, newKeys, keyOf) {
    const key = typeof keyOf === 'function' ? keyOf : (x) => String(x);
    const oldList = (oldKeys || []).map(key);
    const newList = (newKeys || []).map(key);
    const oldSet = new Set(oldList);
    const newSet = new Set(newList);
    const seen = new Set();
    const order = [];
    newList.forEach((k) => {
      if (seen.has(k)) return; // 去重：同键只渲染一次
      seen.add(k);
      order.push(k);
    });
    const keep = order.filter((k) => oldSet.has(k));
    const add = order.filter((k) => !oldSet.has(k));
    const remove = [];
    const removed = new Set();
    oldList.forEach((k) => {
      if (newSet.has(k) || removed.has(k)) return;
      removed.add(k);
      remove.push(k);
    });
    return { keep, add, remove, order };
  }

  // 节点内容签名：签名一样就直接复用 DOM 节点（不重建）
  function signatureOf(parts) {
    return (Array.isArray(parts) ? parts : [parts])
      .map((p) => String(p == null ? '' : p))
      .join('\u0001');
  }

  const api = { planDiff, signatureOf };
  if (typeof window !== 'undefined') window.TravelDiff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
