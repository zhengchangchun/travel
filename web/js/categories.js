/* 分类配置：颜色 / 标签 / 图标映射，全部由后端 /api/config 下发驱动 */
(function () {
  let list = [];

  function get(key) {
    return list.find((c) => c.key === key) || null;
  }

  window.TravelCategories = {
    init(categories) {
      list = Array.isArray(categories) ? categories.slice() : [];
    },
    all() {
      return list.slice();
    },
    get,
    keyOf: (key) => (get(key) ? key : 'other'),
    colorOf: (key) => {
      const c = get(key);
      return c ? c.color : '#8A8F99';
    },
    labelOf: (key) => {
      const c = get(key);
      return c ? c.label : key || '其它';
    },
    iconOf: (key) => {
      const c = get(key);
      return c ? c.icon : 'dot';
    },
    /* 点一下分类 chip 之后该选中哪些类（纯函数，方便单测）：
       · 当前是全选（例如刚关键词搜索完）→ 点某一个 = 只看它。
         否则用户想「只看美食」点一下反而把美食去掉了，结果跟点击前的预期相反。
       · 其余情况是普通 toggle：已选就取消、没选就加上（空集 = 未选分类）。 */
    nextSelection(selected, key, allKeys) {
      const cur = new Set(Array.isArray(selected) ? selected : Array.from(selected || []));
      const all = Array.isArray(allKeys) ? allKeys : [];
      // 注意 cur 为空时 every 是虚真，必须再比一次 size
      const isAll = all.length > 1 && cur.size === all.length && all.every((k) => cur.has(k));
      if (isAll && cur.has(key)) return [key];
      if (cur.has(key)) cur.delete(key);
      else cur.add(key);
      return all.filter((k) => cur.has(k)).concat(Array.from(cur).filter((k) => all.indexOf(k) < 0));
    },
  };
})();
