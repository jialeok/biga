/**
 * rank-vue.js
 * 昨日最大成交额看板 Vue 3 组件化
 * - 复用现有数据层 getRankData / saveData
 * - 覆盖原生 renderRank，切断原生 DOM 渲染
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof Vue === 'undefined') return;

  const { createApp, ref, computed, onMounted, onUnmounted } = Vue;

  // 注入组件级通用样式（编辑浮层）
  (function injectStyles() {
    if (document.getElementById('rank-vue-styles')) return;
    const style = document.createElement('style');
    style.id = 'rank-vue-styles';
    style.textContent = `
      .rank-vue-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.45);
        z-index: 1010;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .rank-vue-modal {
        background: #fff;
        border-radius: 16px;
        width: 100%;
        max-width: 460px;
        max-height: 88vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 20px 50px rgba(0,0,0,0.25);
      }
      .rank-vue-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 16px;
        border-bottom: 1px solid #f1f5f9;
        font-weight: 600;
        font-size: 15px;
        color: #1f2937;
      }
      .rank-vue-modal-header button {
        background: transparent;
        border: none;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
        color: #6b7280;
      }
      .rank-vue-modal-body {
        padding: 12px 16px;
        overflow-y: auto;
      }
      .rank-vue-paste-area {
        margin-bottom: 12px;
      }
      .rank-vue-paste-area textarea {
        width: 100%;
        height: 60px;
        padding: 8px;
        font-size: 12px;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        resize: none;
        box-sizing: border-box;
        font-family: inherit;
      }
      .rank-vue-import-status {
        font-size: 12px;
        margin-top: 4px;
      }
      .rank-vue-form-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
      }
      .rank-vue-form-number {
        width: 22px;
        text-align: center;
        font-size: 12px;
        color: #64748b;
        flex-shrink: 0;
      }
      .rank-vue-form-row input, .rank-vue-form-row select {
        padding: 7px 6px;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        font-size: 13px;
        outline: none;
        box-sizing: border-box;
      }
      .rank-vue-form-row input:focus, .rank-vue-form-row select:focus {
        border-color: #3b82f6;
      }
      .rank-vue-form-stock { flex: 2; min-width: 0; }
      .rank-vue-form-jitu { width: 42px; flex-shrink: 0; text-align: center; }
      .rank-vue-form-percent { flex: 1; min-width: 0; }
      .rank-vue-form-concept { flex: 1.5; min-width: 0; }
      .rank-vue-form-turnover { flex: 1; min-width: 0; }
      .rank-vue-remove-btn {
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 6px;
        background: #fee2e2;
        color: #dc2626;
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .rank-vue-add-btn {
        width: 100%;
        padding: 10px;
        border: 1px dashed #cbd5e1;
        border-radius: 8px;
        background: #f8fafc;
        color: #475569;
        font-size: 13px;
        cursor: pointer;
        margin-top: 4px;
      }
      .rank-vue-modal-footer {
        display: flex;
        gap: 10px;
        padding: 12px 16px 16px;
      }
      .rank-vue-modal-footer button {
        flex: 1;
        padding: 12px;
        border: none;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
      }
      .rank-vue-save-btn { background: #3b82f6; color: #fff; }
      .rank-vue-cancel-btn { background: #f1f5f9; color: #475569; }
      .rank-vue-separator-row input { color: #dc2626; font-weight: 600; text-align: center; }
      .rank-vue-empty-row { height: 20px; background: transparent; }
    `;
    document.head.appendChild(style);
  })();

  function getRankData() {
    return window.getRankData ? window.getRankData() : {};
  }

  function getTodayRank() {
    const date = window.currentDate;
    if (!date) return [];
    return getRankData()[date] || [];
  }

  function saveRankData(list) {
    const date = window.currentDate;
    if (!date) return;
    getRankData()[date] = list;
    if (typeof window.saveData === 'function') window.saveData();
  }

  function parsePercent(raw) {
    if (!raw) return '';
    return String(raw).replace('%', '').trim();
  }

  function parseTurnover(raw) {
    if (!raw) return '';
    return String(raw).replace('亿', '').trim();
  }

  function percentClass(percent) {
    if (!percent && percent !== 0) return 'empty';
    const n = parseFloat(percent) || 0;
    return n >= 0 ? 'rise' : 'fall';
  }

  function percentDisplay(percent) {
    if (!percent && percent !== 0) return '-';
    return percent + '%';
  }

  function turnoverDisplay(turnover) {
    if (!turnover && turnover !== 0) return '-';
    const v = String(turnover).replace('亿', '');
    return v + '亿';
  }

  // 从粘贴文本解析排名数据
  function parseRankPaste(text) {
    const lines = text.split('\n');
    const result = [];
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const trimmedLine = line.trim();
      if (index === 0 && (trimmedLine.includes('股票名称') || trimmedLine.includes('涨幅') || trimmedLine.includes('概念'))) return;

      let cells = line.split('\t');
      const firstCellHasSpaces = cells[0] && cells[0].trim().includes(' ');
      const firstCellIsLong = cells[0] && cells[0].trim().length > 8;
      if (firstCellHasSpaces && firstCellIsLong) {
        cells = trimmedLine.split(/\s+/);
      } else if (cells.length < 2) {
        cells = trimmedLine.split(/\s+/);
      }
      cells = cells.filter(c => c.trim() !== '');
      if (cells.length < 2) return;

      const stock = cells[0].trim();
      let percentRaw = '';
      let concept = '';
      let turnoverRaw = '';

      if (cells.length >= 4) {
        percentRaw = cells[1].trim();
        concept = cells[2].trim();
        turnoverRaw = cells[3].trim();
      } else if (cells.length === 3) {
        const second = cells[1].trim();
        const third = cells[2].trim();
        if (second.includes('%') || second.includes('+') || second.includes('-') || second.startsWith('+') || second.startsWith('-')) {
          percentRaw = second;
          concept = third;
        } else if (third.includes('亿') || third.includes('万') || (!isNaN(parseFloat(third)) && third.match(/\d/))) {
          concept = second;
          turnoverRaw = third;
        } else {
          concept = second;
          turnoverRaw = third;
        }
      } else {
        const second = cells[1].trim();
        if (second.includes('%') || second.includes('+') || second.includes('-') || second.startsWith('+') || second.startsWith('-')) {
          percentRaw = second;
        } else if (second.includes('亿') || second.includes('万') || (!isNaN(parseFloat(second)) && second.match(/\d/))) {
          turnoverRaw = second;
        } else {
          concept = second;
        }
      }

      const percent = parsePercent(percentRaw);
      const turnover = parseTurnover(turnoverRaw);
      if (!stock) return;
      result.push({ stock, jitu: '×', percent, concept, turnover });
    });
    return result;
  }

  function mergeImportedRows(existing, imported) {
    const hasStockData = existing.some(item => item && item.stock);
    if (!hasStockData) return imported;

    let beforeSeparator = [];
    let separatorIndex = -1;
    let afterSeparator = [];
    existing.forEach((item, index) => {
      if (item.type === 'separator') separatorIndex = index;
      else if (separatorIndex === -1) beforeSeparator.push(item);
      else afterSeparator.push(item);
    });

    const allExisting = [...beforeSeparator, ...afterSeparator];
    imported.forEach(newItem => {
      let existingIndex = beforeSeparator.findIndex(item => item && item.stock === newItem.stock);
      if (existingIndex === -1) existingIndex = afterSeparator.findIndex(item => item && item.stock === newItem.stock);
      if (existingIndex !== -1) {
        const arr = existingIndex < beforeSeparator.length ? beforeSeparator : afterSeparator;
        const idx = existingIndex < beforeSeparator.length ? existingIndex : existingIndex - beforeSeparator.length;
        const item = arr[idx];
        if (!item.percent && newItem.percent) item.percent = newItem.percent;
        if (!item.concept && newItem.concept) item.concept = newItem.concept;
        if (!item.turnover && newItem.turnover) item.turnover = newItem.turnover;
      } else {
        afterSeparator.push(newItem);
      }
    });

    const hasCompleteData = afterSeparator.some(item => item && item.stock && item.percent && item.concept && item.turnover);
    beforeSeparator = beforeSeparator.filter(item => item && item.stock);
    afterSeparator = afterSeparator.filter(item => item && item.stock);

    const final = [...beforeSeparator];
    if (hasCompleteData && afterSeparator.length > 0) {
      final.push({ type: 'empty' });
      const now = new Date();
      const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      final.push({ type: 'separator', time: timeStr });
    }
    return [...final, ...afterSeparator];
  }

  const RankBoard = {
    setup() {
      const list = ref([]);
      const showModal = ref(false);
      const draft = ref([]);
      const importText = ref('');
      const importStatus = ref({ text: '', color: '#64748b' });
      let lastDate = null;

      function refresh() {
        const date = window.currentDate;
        if (date !== lastDate) {
          lastDate = date;
          showModal.value = false;
        }
        list.value = getTodayRank();
      }
      window.vueRankBoardRefresh = refresh;

      const displayList = computed(() => {
        const result = [];
        let displayIndex = 0;
        (list.value || []).forEach(item => {
          if (item && item.type === 'empty') {
            result.push({ kind: 'empty' });
          } else if (item && item.type === 'separator') {
            result.push({ kind: 'separator', time: item.time || '' });
            displayIndex = 0;
          } else {
            displayIndex++;
            result.push({
              kind: 'stock',
              index: displayIndex,
              stock: item.stock || '-',
              jitu: item.jitu || '×',
              percent: item.percent || '',
              concept: item.concept || '-',
              turnover: item.turnover || '',
              isChecked: item.jitu === '✓'
            });
          }
        });
        return result;
      });

      function openEdit() {
        draft.value = JSON.parse(JSON.stringify(list.value || []));
        importText.value = '';
        importStatus.value = { text: '', color: '#64748b' };
        showModal.value = true;
      }
      window.vueRankBoardOpenEdit = openEdit;

      function closeEdit() {
        showModal.value = false;
      }

      function addRow() {
        draft.value.push({ stock: '', jitu: '×', percent: '', concept: '', turnover: '' });
      }

      function removeRow(index) {
        draft.value.splice(index, 1);
      }

      function onImport() {
        const imported = parseRankPaste(importText.value);
        if (imported.length === 0) {
          importStatus.value = { text: '未能解析到有效数据！', color: '#dc2626' };
          return;
        }
        draft.value = mergeImportedRows(draft.value, imported);
        importText.value = '';
        importStatus.value = { text: `✅ 成功导入 ${imported.length} 条数据`, color: '#059669' };
      }

      function save() {
        const result = [];
        draft.value.forEach(item => {
          if (item.type === 'empty') {
            result.push({ type: 'empty' });
          } else if (item.type === 'separator') {
            result.push({ type: 'separator', time: item.time || '' });
          } else {
            const stock = (item.stock || '').trim();
            if (stock) {
              result.push({
                stock,
                jitu: item.jitu || '×',
                percent: parsePercent(item.percent),
                concept: (item.concept || '').trim(),
                turnover: parseTurnover(item.turnover)
              });
            }
          }
        });
        list.value = result;
        saveRankData(result);
        showModal.value = false;
      }

      // 日期/数据变化轮询
      let timer = setInterval(() => {
        if (window.currentDate !== lastDate) refresh();
      }, 200);
      onMounted(refresh);
      onUnmounted(() => clearInterval(timer));

      return {
        displayList,
        showModal,
        draft,
        importText,
        importStatus,
        openEdit,
        closeEdit,
        addRow,
        removeRow,
        onImport,
        save,
        percentClass,
        percentDisplay,
        turnoverDisplay
      };
    },
    template: `
      <div class="rank-header" @dblclick.stop="openEdit">
        <div class="rank-title">昨日最大成交额</div>
        <div class="rank-subtitle"></div>
      </div>
      <div class="rank-content" @dblclick.stop="openEdit">
        <div class="rank-header-row">
          <div class="rank-header-item rank-header-number">排名</div>
          <div class="rank-header-item rank-header-stock">股票名称</div>
          <div class="rank-header-item rank-header-jitu">竞图</div>
          <div class="rank-header-item rank-header-diezhang">涨幅</div>
          <div class="rank-header-item rank-header-concept">题材概念</div>
          <div class="rank-header-item rank-header-turnover">成交额</div>
        </div>
        <template v-if="displayList.length === 0">
          <div style="text-align:center;padding:20px;color:#9ca3af;font-size:13px">暂无排名数据</div>
        </template>
        <template v-else>
          <div v-for="(item, idx) in displayList" :key="idx" :class="['rank-item', item.kind === 'empty' ? '' : '']" :style="item.kind === 'empty' ? 'height:16px;background:transparent;' : ''">
            <template v-if="item.kind === 'empty'"></template>
            <template v-else-if="item.kind === 'separator'">
              <div class="rank-number"></div>
              <div class="rank-stock-name" style="color:#dc2626;font-weight:600;">今日排行</div>
              <div class="rank-jitu"></div>
              <div class="rank-diezhang"></div>
              <div class="rank-concept" style="color:#dc2626;font-weight:600;">{{ item.time }}</div>
              <div class="rank-turnover"></div>
            </template>
            <template v-else>
              <div class="rank-number">{{ item.index }}</div>
              <div class="rank-stock-name">{{ item.stock }}</div>
              <div class="rank-jitu" :class="item.isChecked ? 'checked' : 'unchecked'">{{ item.jitu }}</div>
              <div class="rank-diezhang" :class="percentClass(item.percent)">{{ percentDisplay(item.percent) }}</div>
              <div class="rank-concept" :class="item.isChecked ? 'red-text' : ''">{{ item.concept }}</div>
              <div class="rank-turnover">{{ turnoverDisplay(item.turnover) }}</div>
            </template>
          </div>
        </template>
      </div>

      <div v-if="showModal" class="rank-vue-modal-backdrop" @click.self="closeEdit">
        <div class="rank-vue-modal">
          <div class="rank-vue-modal-header">
            <span>编辑昨日最大成交额</span>
            <button @click="closeEdit">&times;</button>
          </div>
          <div class="rank-vue-modal-body">
            <div class="rank-vue-paste-area">
              <textarea v-model="importText" placeholder="从 Excel 复制后直接粘贴到这里"></textarea>
              <div class="rank-vue-import-status" :style="{ color: importStatus.color }">{{ importStatus.text }}</div>
              <button type="button" class="rank-vue-add-btn" @click="onImport">导入粘贴数据</button>
            </div>

            <div v-for="(item, idx) in draft" :key="idx" :class="['rank-vue-form-row', item.type === 'empty' ? 'rank-vue-empty-row' : '', item.type === 'separator' ? 'rank-vue-separator-row' : '']">
              <template v-if="item.type === 'empty'">
                <div class="rank-vue-form-number"></div>
                <input class="rank-vue-form-stock" disabled placeholder="-" style="visibility:hidden">
                <select class="rank-vue-form-jitu" disabled style="visibility:hidden"><option>×</option></select>
                <input class="rank-vue-form-percent" disabled style="visibility:hidden">
                <input class="rank-vue-form-concept" disabled style="visibility:hidden">
                <input class="rank-vue-form-turnover" disabled style="visibility:hidden">
                <button type="button" class="rank-vue-remove-btn" @click="removeRow(idx)">&times;</button>
              </template>
              <template v-else-if="item.type === 'separator'">
                <div class="rank-vue-form-number"></div>
                <input class="rank-vue-form-stock" value="今日排行" readonly>
                <select class="rank-vue-form-jitu" disabled style="visibility:hidden"><option>×</option></select>
                <input class="rank-vue-form-percent" disabled style="visibility:hidden">
                <input class="rank-vue-form-concept" v-model="item.time" placeholder="时间">
                <input class="rank-vue-form-turnover" disabled style="visibility:hidden">
                <button type="button" class="rank-vue-remove-btn" @click="removeRow(idx)">&times;</button>
              </template>
              <template v-else>
                <div class="rank-vue-form-number">{{ idx + 1 }}</div>
                <input class="rank-vue-form-stock" v-model="item.stock" placeholder="名称">
                <select class="rank-vue-form-jitu" v-model="item.jitu">
                  <option value="×">×</option>
                  <option value="✓">✓</option>
                </select>
                <input class="rank-vue-form-percent" v-model="item.percent" placeholder="涨幅">
                <input class="rank-vue-form-concept" v-model="item.concept" placeholder="题材">
                <input class="rank-vue-form-turnover" v-model="item.turnover" placeholder="额">
                <button type="button" class="rank-vue-remove-btn" @click="removeRow(idx)">&times;</button>
              </template>
            </div>
            <button type="button" class="rank-vue-add-btn" @click="addRow">+ 添加新行</button>
          </div>
          <div class="rank-vue-modal-footer">
            <button type="button" class="rank-vue-save-btn" @click="save">保存</button>
            <button type="button" class="rank-vue-cancel-btn" @click="closeEdit">取消</button>
          </div>
        </div>
      </div>
    `
  };

  function mountRankBoard() {
    const el = document.querySelector('.rank-board.trading-day-element');
    if (!el) return;
    // 移除原生 ondblclick 避免冲突
    el.removeAttribute('ondblclick');
    el.innerHTML = '<div id="rank-vue-root"></div>';
    createApp(RankBoard).mount('#rank-vue-root');

    // 覆盖原生 renderRank：仅触发 Vue 刷新
    window.renderRank = function () {
      if (typeof window.vueRankBoardRefresh === 'function') {
        window.vueRankBoardRefresh();
      }
    };

    // 覆盖旧编辑入口
    window.openRankEdit = function () {
      if (typeof window.vueRankBoardOpenEdit === 'function') {
        window.vueRankBoardOpenEdit();
      }
    };
  }

  // 暴露打开编辑的入口（Vue 实例挂载后才可用，因此通过事件委托）
  window.vueRankBoardOpenEdit = function () {
    // 由 Vue 组件内部处理，外部无需操作；保留空函数避免报错
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountRankBoard);
  } else {
    mountRankBoard();
  }
})();
