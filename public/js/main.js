/**
 * main.js — 分頁切換、時鐘、開機初始化
 */
(function () {
  const $ = id => document.getElementById(id);

  /* ------------------------------------------------------- tab switch --- */
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $(`page-${btn.dataset.page}`).classList.add("active");

      if (btn.dataset.page === "war") {
        // 戰情室延遲初始化（容器可見後 ECharts 才量得到尺寸）
        setTimeout(() => window.WarRoom.init(), 30);
      } else {
        setTimeout(() => window.ShapUI.resize(), 30);
      }
    });
  });

  /* ------------------------------------------------------------ clock --- */
  function tickClock() {
    $("clock").textContent = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ------------------------------------------------------------- boot --- */
  window.ShapUI.init();
  window.Copilot.probe();
})();
