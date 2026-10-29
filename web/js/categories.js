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
  };
})();
