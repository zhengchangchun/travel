/* 登录 / 注册（同一个表单，两种模式） */
(function () {
  const Site = window.TravelSite;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(window.location.search);
  const next = params.get('next') || '/';
  let mode = params.get('mode') === 'register' ? 'register' : 'login';

  function paint() {
    const reg = mode === 'register';
    $('lg-title').textContent = reg ? '注册新账号' : '登录';
    $('lg-submit').textContent = reg ? '注册并登录' : '登录';
    $('lg-toggle').textContent = reg ? '已有账号？去登录' : '没有账号？去注册';
    $('lg-nick-wrap').style.display = reg ? '' : 'none';
    $('lg-pass').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    $('lg-msg').textContent = '';
  }

  function say(msg, ok) {
    const el = $('lg-msg');
    el.textContent = msg || '';
    el.className = 'form-msg' + (ok ? ' ok' : '');
  }

  async function submit() {
    const username = $('lg-user').value.trim();
    const password = $('lg-pass').value;
    const nickname = $('lg-nick').value.trim();
    if (!username || !password) {
      say('账号和密码都要填');
      return;
    }
    $('lg-submit').disabled = true;
    try {
      if (mode === 'register') await Site.api.register(username, password, nickname);
      else await Site.api.login(username, password);
      say('好了，正在跳转…', true);
      window.location.href = next;
    } catch (err) {
      say(err.message || '失败了，再试一次');
      $('lg-submit').disabled = false;
    }
  }

  (async function init() {
    if (window.TravelHead) await window.TravelHead.start();
    paint();
    $('lg-toggle').onclick = () => {
      mode = mode === 'register' ? 'login' : 'register';
      paint();
    };
    $('lg-submit').onclick = submit;
    ['lg-user', 'lg-pass', 'lg-nick'].forEach((id) => {
      $(id).onkeydown = (e) => {
        if (e.key === 'Enter') submit();
      };
    });
    $('lg-user').focus();
  })();
})();
