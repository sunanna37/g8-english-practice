(function () {
  const STORAGE_KEY = 'g8_eng_quiz_state_v1';
  const BANK = window.QUESTION_BANK || [];

  // Default persistent state
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          cycle: parsed.cycle || 1,
          seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds : [],
          mistakes: parsed.mistakes && typeof parsed.mistakes === 'object' ? parsed.mistakes : {},
          roundsDone: parsed.roundsDone || 0,
          totalAnswered: parsed.totalAnswered || 0,
          totalCorrect: parsed.totalCorrect || 0,
          history: Array.isArray(parsed.history) ? parsed.history : [],
          autoRemoveMistake: parsed.autoRemoveMistake !== undefined ? parsed.autoRemoveMistake : true
        };
      }
    } catch (e) {
      console.error('Failed to load state:', e);
    }
    return {
      cycle: 1,
      seenIds: [],
      mistakes: {}, // { [qId]: { count, lastWrongUserAns, timestamp } }
      roundsDone: 0,
      totalAnswered: 0,
      totalCorrect: 0,
      history: [],
      autoRemoveMistake: true
    };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    } catch (e) {
      console.error('Failed to save state:', e);
    }
  }

  let appState = loadState();

  // Active Quiz Session
  let currentQuiz = {
    mode: 'mixed', // 'mixed' | 'custom' | 'mistakes'
    title: '第 1 回混合練習',
    questions: [],
    currentIndex: 0,
    responses: {} // { [qId]: { userAns, isCorrect } }
  };

  // Utility: Fisher-Yates shuffle
  function shuffleArray(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // Group questions into atomic blocks (so cloze passages stay together in order)
  function buildAtomicBlocks(questionPool) {
    const blocks = [];
    const clozeMap = new Map();

    for (const q of questionPool) {
      if (q.type === 'cloze' && q.groupId) {
        if (!clozeMap.has(q.groupId)) {
          const groupArr = [];
          clozeMap.set(q.groupId, groupArr);
          blocks.push(groupArr);
        }
        clozeMap.get(q.groupId).push(q);
      } else {
        blocks.push([q]);
      }
    }

    // Ensure cloze questions inside each group are sorted by subNum
    for (const groupArr of clozeMap.values()) {
      groupArr.sort((a, b) => (a.subNum || 0) - (b.subNum || 0));
    }
    return blocks;
  }

  /**
   * Non-repeating Smart Sampler:
   * - Filters pool by units & categories
   * - Splits pool into unseen blocks and seen blocks
   * - If unseen questions are enough, picks proportionally from U3, U4, Review2 without repeating
   * - If unseen questions run out (< targetCount), takes all remaining unseen questions,
   *   increments cycle (resets seenIds to the newly drawn unseen ones), and fills the remainder
   *   from the rest of the pool without duplicating any question in the same quiz.
   */
  function sampleQuestions({ units, categories, targetCount }) {
    const eligible = BANK.filter(
      (q) => units.includes(q.unit) && categories.includes(q.category)
    );
    if (eligible.length === 0) return [];

    const actualTarget = Math.min(targetCount, eligible.length);
    const seenSet = new Set(appState.seenIds);

    const unseenEligible = eligible.filter((q) => !seenSet.has(q.id));
    let selected = [];

    if (unseenEligible.length >= actualTarget) {
      selected = pickBalancedBlocks(unseenEligible, actualTarget);
    } else {
      // Take all remaining unseen first
      const firstPart = unseenEligible.slice();
      const firstPartIds = new Set(firstPart.map((q) => q.id));

      // Pool exhausted! Start a new cycle for the eligible set
      appState.cycle += 1;
      // Remove eligible IDs from seenIds so they can be drawn fresh
      const eligibleIds = new Set(eligible.map((q) => q.id));
      appState.seenIds = appState.seenIds.filter((id) => !eligibleIds.has(id));
      saveState();

      const remainingNeeded = actualTarget - firstPart.length;
      const refillPool = eligible.filter((q) => !firstPartIds.has(q.id));
      const secondPart = pickBalancedBlocks(refillPool, remainingNeeded);
      selected = [...firstPart, ...secondPart];
    }

    return selected;
  }

  function pickBalancedBlocks(pool, targetCount) {
    // Group by unit so U3, U4, Review2 are all well-represented
    const byUnit = {
      Review2: pool.filter((q) => q.unit === 'Review2'),
      U3: pool.filter((q) => q.unit === 'U3'),
      U4: pool.filter((q) => q.unit === 'U4')
    };

    const blocksR2 = shuffleArray(buildAtomicBlocks(byUnit.Review2));
    const blocksU3 = shuffleArray(buildAtomicBlocks(byUnit.U3));
    const blocksU4 = shuffleArray(buildAtomicBlocks(byUnit.U4));

    const chosenBlocks = [];
    let count = 0;

    // 1. Include 1 block from Review 2 if available (so Review 2 is mixed in)
    if (blocksR2.length > 0 && count < targetCount) {
      const b = blocksR2.pop();
      chosenBlocks.push(b);
      count += b.length;
    }

    // 2. Alternate pulling from U3 and U4 (and remaining R2) to keep U3/U4 balanced
    let turn = Math.random() < 0.5 ? 'U3' : 'U4';
    while (count < targetCount && (blocksU3.length > 0 || blocksU4.length > 0 || blocksR2.length > 0)) {
      let source = null;
      if (turn === 'U3' && blocksU3.length > 0) {
        source = blocksU3;
        turn = 'U4';
      } else if (turn === 'U4' && blocksU4.length > 0) {
        source = blocksU4;
        turn = 'U3';
      } else if (blocksU3.length > 0) {
        source = blocksU3;
      } else if (blocksU4.length > 0) {
        source = blocksU4;
      } else if (blocksR2.length > 0) {
        source = blocksR2;
      }

      if (!source || source.length === 0) break;

      // Find a block that fits nicely (allow +2 slack for cloze group, or exact fit)
      const b = source.pop();
      if (count + b.length <= targetCount + 2 || count < targetCount - 1) {
        chosenBlocks.push(b);
        count += b.length;
      }
    }

    // Shuffle the order of blocks so categories/units are interleaved, while keeping each cloze group contiguous
    const finalBlocks = shuffleArray(chosenBlocks);
    return finalBlocks.flat();
  }

  // Unit badge class helper
  function getUnitBadgeClass(unit) {
    if (unit === 'U3') return 'unit-pill u3';
    if (unit === 'U4') return 'unit-pill u4';
    if (unit === 'Review2') return 'unit-pill r2';
    return 'unit-pill neutral';
  }

  // Navigation switching
  function switchView(viewName) {
    document.querySelectorAll('.view-section').forEach((sec) => {
      sec.classList.remove('active');
    });
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.add('active');

    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (viewName === 'dashboard') renderDashboard();
    if (viewName === 'mistakes') renderMistakesView();
    if (viewName === 'bank') renderBankView();
  }

  // Render Dashboard
  function renderDashboard() {
    const totalBank = BANK.length;
    const seenCount = new Set(appState.seenIds).size;
    const remaining = Math.max(0, totalBank - seenCount);
    const pct = totalBank > 0 ? Math.round((seenCount / totalBank) * 100) : 0;
    const mistakeCount = Object.keys(appState.mistakes).length;

    document.getElementById('stat-total-bank').textContent = totalBank;
    document.getElementById('stat-cycle-num').textContent = appState.cycle;
    document.getElementById('stat-progress-pct').textContent = `${pct}%`;
    document.getElementById('stat-progress-bar').style.width = `${pct}%`;
    document.getElementById('stat-seen-count').textContent = seenCount;
    document.getElementById('stat-total-count').textContent = totalBank;
    document.getElementById('stat-remaining-count').textContent = remaining;

    document.getElementById('stat-rounds-done').textContent = appState.roundsDone;
    const acc =
      appState.totalAnswered > 0
        ? Math.round((appState.totalCorrect / appState.totalAnswered) * 100) + '%'
        : '--%';
    document.getElementById('stat-accuracy').textContent = acc;
    document.getElementById('stat-answered-detail').textContent = `累積作答 ${appState.totalAnswered} 題（答對 ${appState.totalCorrect} 題）`;

    document.getElementById('stat-mistake-total').textContent = mistakeCount;
    document.getElementById('nav-mistake-count').textContent = mistakeCount;
    document.getElementById('hero-mistake-count').textContent = mistakeCount;

    const quickMistakeBtn = document.getElementById('btn-quick-mistakes');
    quickMistakeBtn.style.display = mistakeCount > 0 ? 'inline-flex' : 'none';

    // Recent History
    const histEl = document.getElementById('recent-history-list');
    if (!appState.history || appState.history.length === 0) {
      histEl.innerHTML = `<div class="empty-state-sm">尚無練習紀錄，點擊上方「開始新一回混合練習」開始吧！</div>`;
    } else {
      histEl.innerHTML = appState.history
        .slice(0, 8)
        .map((h) => {
          const scoreClass = h.pct >= 80 ? 'high' : h.pct >= 60 ? 'mid' : 'low';
          return `
            <div class="history-item">
              <div>
                <strong>${escapeHtml(h.title)}</strong>
                <div style="font-size:0.78rem;color:#64748b;">${escapeHtml(h.date)} ・ 答對 ${h.correct}/${h.total} 題</div>
              </div>
              <span class="history-score ${scoreClass}">${h.pct}%</span>
            </div>
          `;
        })
        .join('');
    }
  }

  // Start a Quiz Session
  function startQuizSession({ mode, title, questions }) {
    if (!questions || questions.length === 0) {
      alert('沒有符合條件的題目！請調整篩選範圍。');
      return;
    }
    currentQuiz = {
      mode,
      title,
      questions,
      currentIndex: 0,
      responses: {}
    };

    document.getElementById('quiz-mode-title').textContent = title;
    switchView('quiz');
    renderCurrentQuestion();
  }

  function renderCurrentQuestion() {
    const q = currentQuiz.questions[currentQuiz.currentIndex];
    const total = currentQuiz.questions.length;
    const idx = currentQuiz.currentIndex;
    const resp = currentQuiz.responses[q.id];

    // Live tallies
    let correctCnt = 0;
    let wrongCnt = 0;
    Object.values(currentQuiz.responses).forEach((r) => {
      if (r.isCorrect) correctCnt++;
      else wrongCnt++;
    });
    document.getElementById('live-correct').textContent = correctCnt;
    document.getElementById('live-wrong').textContent = wrongCnt;

    // Progress bar
    const answeredCount = Object.keys(currentQuiz.responses).length;
    const pct = Math.round(((idx + 1) / total) * 100);
    document.getElementById('quiz-curr-idx').textContent = idx + 1;
    document.getElementById('quiz-total-idx').textContent = total;
    document.getElementById('quiz-pct-text').textContent = `已完成 ${answeredCount} / ${total} 題`;
    document.getElementById('quiz-progress-bar').style.width = `${pct}%`;

    // Dots navigator
    const dotsContainer = document.getElementById('quiz-dots-nav');
    dotsContainer.innerHTML = currentQuiz.questions
      .map((item, i) => {
        const r = currentQuiz.responses[item.id];
        let cls = 'q-dot';
        if (i === idx) cls += ' current';
        if (r) cls += r.isCorrect ? ' answered-correct' : ' answered-wrong';
        return `<button class="${cls}" data-idx="${i}" title="第 ${i + 1} 題">${i + 1}</button>`;
      })
      .join('');

    dotsContainer.querySelectorAll('.q-dot').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentQuiz.currentIndex = parseInt(btn.dataset.idx, 10);
        renderCurrentQuestion();
      });
    });

    // Header badges
    const unitBadge = document.getElementById('q-unit-badge');
    unitBadge.className = getUnitBadgeClass(q.unit);
    unitBadge.textContent = q.unitLabel;
    document.getElementById('q-cat-badge').textContent = q.category;
    document.getElementById('q-id-badge').textContent = `#${q.id}`;

    // Cloze passage
    const passageBox = document.getElementById('q-passage-box');
    if (q.type === 'cloze' && q.passage) {
      passageBox.style.display = 'block';
      document.getElementById('q-cloze-group-info').textContent = `（第 ${q.subNum} / ${q.totalSubs} 小題）`;
      // Highlight current blank
      const highlighted = escapeHtml(q.passage).replace(
        /___\((\d+)\)___/g,
        (match, num) => {
          const isCurr = parseInt(num, 10) === q.subNum;
          return `<span class="cloze-blank ${isCurr ? 'active-blank' : ''}">(${num})</span>`;
        }
      );
      document.getElementById('q-passage-text').innerHTML = highlighted;
    } else {
      passageBox.style.display = 'none';
    }

    // Image
    const imgBox = document.getElementById('q-image-box');
    const imgEl = document.getElementById('q-image');
    if (q.image) {
      imgBox.style.display = 'block';
      imgEl.src = q.image;
    } else {
      imgBox.style.display = 'none';
      imgEl.src = '';
    }

    // Question stem
    document.getElementById('q-stem-text').innerHTML = `${idx + 1}. ${formatStemHtml(q.question)}`;

    // Options vs Fill-in
    const optionsBox = document.getElementById('q-options-box');
    const fillBox = document.getElementById('q-fill-box');

    if (q.type === 'mcq' || q.type === 'cloze') {
      optionsBox.style.display = 'grid';
      fillBox.style.display = 'none';

      const keys = ['A', 'B', 'C', 'D'];
      optionsBox.innerHTML = keys
        .map((k) => {
          const optText = (q.options && q.options[k]) || '';
          let btnCls = 'option-btn';
          if (resp) {
            if (k === q.answer) btnCls += ' correct-choice';
            else if (k === resp.userAns && !resp.isCorrect) btnCls += ' wrong-choice';
          }
          return `
            <button class="${btnCls}" data-opt="${k}" ${resp ? 'disabled' : ''}>
              <span class="opt-letter">${k}</span>
              <span class="opt-text">${escapeHtml(optText)}</span>
            </button>
          `;
        })
        .join('');

      if (!resp) {
        optionsBox.querySelectorAll('.option-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            handleUserAnswer(q, btn.dataset.opt);
          });
        });
      }
    } else if (q.type === 'fill') {
      optionsBox.style.display = 'none';
      fillBox.style.display = 'block';
      const inputEl = document.getElementById('fill-answer-input');
      const submitBtn = document.getElementById('btn-submit-fill');
      inputEl.value = resp ? resp.userAns : '';
      inputEl.disabled = !!resp;
      submitBtn.disabled = !!resp;
      if (!resp) {
        setTimeout(() => inputEl.focus(), 50);
      }
    }

    // Feedback Panel
    const fbPanel = document.getElementById('q-feedback-panel');
    if (resp) {
      fbPanel.style.display = 'block';
      fbPanel.className = `feedback-panel ${resp.isCorrect ? 'is-correct' : 'is-wrong'}`;
      document.getElementById('feedback-icon').textContent = resp.isCorrect ? '✓' : '✗';

      if (resp.isCorrect) {
        const removedMsg =
          currentQuiz.mode === 'mistakes' && appState.autoRemoveMistake
            ? '（已從錯題區移除！）'
            : '';
        document.getElementById('feedback-title').textContent = `答對了！太棒了！${removedMsg}`;
        document.getElementById('feedback-correct-ans').textContent = `正確答案：${formatCorrectAnswer(q)}`;
      } else {
        document.getElementById('feedback-title').textContent = `答錯了，已自動加入錯題本！`;
        document.getElementById('feedback-correct-ans').textContent = `你的作答：${resp.userAns || '(未填)'} ｜ 正確答案：${formatCorrectAnswer(q)}`;
      }

      const expEl = document.getElementById('feedback-explanation');
      if (q.explanation) {
        expEl.style.display = 'block';
        expEl.textContent = q.explanation;
      } else {
        expEl.style.display = 'block';
        expEl.textContent = `解析：本題正確答案為 ${formatCorrectAnswer(q)}。`;
      }
    } else {
      fbPanel.style.display = 'none';
    }

    // Footer buttons
    document.getElementById('btn-prev-q').disabled = idx === 0;
    const nextBtn = document.getElementById('btn-next-q');
    const finishBtn = document.getElementById('btn-finish-quiz');

    if (idx < total - 1) {
      nextBtn.style.display = resp ? 'inline-flex' : 'none';
      finishBtn.style.display = 'none';
    } else {
      nextBtn.style.display = 'none';
      finishBtn.style.display = resp ? 'inline-flex' : 'none';
    }
  }

  function formatCorrectAnswer(q) {
    if (q.type === 'mcq' || q.type === 'cloze') {
      const text = q.options && q.options[q.answer] ? q.options[q.answer] : '';
      return `(${q.answer}) ${text}`;
    }
    return q.answer;
  }

  function normalizeFillAnswer(str) {
    return (str || '')
      .trim()
      .toLowerCase()
      .replace(/[；;,，]+/g, ' ')
      .replace(/\s+/g, ' ');
  }

  function checkFillAnswer(q, userRaw) {
    const normUser = normalizeFillAnswer(userRaw);
    const normExpected = normalizeFillAnswer(q.answer);
    if (normUser === normExpected) return true;

    // Also allow if student typed only the missing middle letters for single word fill
    return false;
  }

  function handleUserAnswer(q, userAnsRaw) {
    if (currentQuiz.responses[q.id]) return; // already answered

    let isCorrect = false;
    const userAns = (userAnsRaw || '').trim();

    if (q.type === 'mcq' || q.type === 'cloze') {
      isCorrect = userAns.toUpperCase() === q.answer.toUpperCase();
    } else {
      isCorrect = checkFillAnswer(q, userAns);
    }

    currentQuiz.responses[q.id] = {
      userAns,
      isCorrect
    };

    // Update persistent seenIds (for non-mistake mode, or even all modes)
    if (!appState.seenIds.includes(q.id)) {
      appState.seenIds.push(q.id);
    }

    appState.totalAnswered += 1;
    if (isCorrect) {
      appState.totalCorrect += 1;
      if (currentQuiz.mode === 'mistakes' && appState.autoRemoveMistake && appState.mistakes[q.id]) {
        delete appState.mistakes[q.id];
      }
    } else {
      // Record in mistakes
      const prev = appState.mistakes[q.id] || { count: 0 };
      appState.mistakes[q.id] = {
        count: prev.count + 1,
        lastWrongUserAns: userAns,
        timestamp: Date.now()
      };
    }

    saveState();
    document.getElementById('nav-mistake-count').textContent = Object.keys(appState.mistakes).length;
    renderCurrentQuestion();
  }

  // Finish Quiz & Show Summary
  function finishQuizSession() {
    const total = currentQuiz.questions.length;
    let correct = 0;
    let wrong = 0;
    const wrongQuestions = [];

    currentQuiz.questions.forEach((q) => {
      const r = currentQuiz.responses[q.id];
      if (r && r.isCorrect) {
        correct++;
      } else {
        wrong++;
        wrongQuestions.push(q);
      }
    });

    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

    appState.roundsDone += 1;
    const now = new Date();
    const dateStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    appState.history.unshift({
      title: currentQuiz.title,
      date: dateStr,
      correct,
      total,
      pct
    });
    if (appState.history.length > 25) appState.history.pop();
    saveState();

    // Populate Summary UI
    document.getElementById('summary-trophy').textContent =
      pct >= 90 ? '🏆' : pct >= 75 ? '🌟' : pct >= 60 ? '👍' : '💪';
    document.getElementById('summary-title').textContent = `${currentQuiz.title} 完成！`;
    document.getElementById('sum-score-pct').textContent = `${pct}%`;
    document.getElementById('sum-correct-cnt').textContent = correct;
    document.getElementById('sum-wrong-cnt').textContent = wrong;
    document.getElementById('sum-total-cnt').textContent = total;

    const btnReviewWrong = document.getElementById('btn-sum-review-wrong');
    if (wrongQuestions.length > 0) {
      btnReviewWrong.style.display = 'inline-flex';
      btnReviewWrong.textContent = `立即重練本回錯題 (${wrongQuestions.length} 題)`;
      btnReviewWrong.onclick = () => {
        startQuizSession({
          mode: 'mistakes',
          title: '本回錯題立即重練',
          questions: wrongQuestions
        });
      };
    } else {
      btnReviewWrong.style.display = 'none';
    }

    const listEl = document.getElementById('summary-questions-list');
    listEl.innerHTML = currentQuiz.questions
      .map((q, idx) => renderReviewCardHtml(q, idx + 1, currentQuiz.responses[q.id]))
      .join('');

    switchView('summary');
  }

  function renderReviewCardHtml(q, numLabel, resp, showRemoveBtn = false) {
    const isCorrect = resp ? resp.isCorrect : null;
    const borderCls =
      isCorrect === true ? 'correct-border' : isCorrect === false ? 'wrong-border' : '';

    let optionsHtml = '';
    if ((q.type === 'mcq' || q.type === 'cloze') && q.options) {
      optionsHtml = `<div class="review-item-options">
        ${['A', 'B', 'C', 'D']
          .map((k) => {
            let cls = 'rev-opt';
            if (k === q.answer) cls += ' is-ans';
            else if (resp && resp.userAns === k && !resp.isCorrect) cls += ' is-user-wrong';
            return `<div class="${cls}">(${k}) ${escapeHtml(q.options[k] || '')}</div>`;
          })
          .join('')}
      </div>`;
    } else {
      const userPart =
        resp && !resp.isCorrect
          ? `<span style="color:#dc2626;margin-right:1rem;">你的作答：${escapeHtml(resp.userAns || '(未答)')}</span>`
          : '';
      optionsHtml = `<div style="margin-bottom:0.65rem;font-size:0.95rem;">
        ${userPart}
        <strong style="color:#15803d;">正確答案：${escapeHtml(q.answer)}</strong>
      </div>`;
    }

    const passageHtml =
      q.type === 'cloze' && q.passage
        ? `<div class="cloze-passage-box" style="margin-bottom:0.75rem;padding:0.75rem 1rem;font-size:0.9rem;">${escapeHtml(q.passage)}</div>`
        : '';

    const removeBtnHtml = showRemoveBtn
      ? `<button class="btn btn-ghost btn-sm btn-remove-mistake" data-id="${q.id}" style="margin-left:auto;">✓ 已學會，移除錯題</button>`
      : '';

    return `
      <div class="review-item ${borderCls}">
        <div class="review-item-header">
          <span class="${getUnitBadgeClass(q.unit)}">${q.unitLabel}</span>
          <span class="cat-pill">${q.category}</span>
          <span style="font-size:0.8rem;color:#64748b;font-family:monospace;">#${q.id}</span>
          ${
            appState.mistakes[q.id]
              ? `<span class="score-pill wrong" style="font-size:0.75rem;padding:0.1rem 0.5rem;">累計答錯 ${appState.mistakes[q.id].count} 次</span>`
              : ''
          }
          ${removeBtnHtml}
        </div>
        ${passageHtml}
        <div class="review-item-stem">${numLabel ? numLabel + '. ' : ''}${formatStemHtml(q.question)}</div>
        ${optionsHtml}
        <div class="review-item-exp">${escapeHtml(q.explanation || '正解：' + formatCorrectAnswer(q))}</div>
      </div>
    `;
  }

  // Render Mistakes View
  function renderMistakesView() {
    const unitFilter = document.getElementById('mistake-filter-unit').value;
    const catFilter = document.getElementById('mistake-filter-cat').value;
    document.getElementById('chk-auto-remove-mistake').checked = appState.autoRemoveMistake;

    const mistakeIds = Object.keys(appState.mistakes);
    document.getElementById('nav-mistake-count').textContent = mistakeIds.length;

    const filtered = BANK.filter((q) => {
      if (!appState.mistakes[q.id]) return false;
      if (unitFilter !== 'ALL' && q.unit !== unitFilter) return false;
      if (catFilter !== 'ALL' && q.category !== catFilter) return false;
      return true;
    });

    const container = document.getElementById('mistakes-list-container');
    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h3 style="margin-bottom:0.4rem;">🎉 目前沒有符合條件的錯題！</h3>
          <p>去進行幾回混合練習，答錯的題目會自動收錄到這裡供你隨時複習。</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered
      .map((q, idx) => {
        const m = appState.mistakes[q.id];
        const fakeResp = { userAns: m.lastWrongUserAns, isCorrect: false };
        return renderReviewCardHtml(q, idx + 1, fakeResp, true);
      })
      .join('');

    container.querySelectorAll('.btn-remove-mistake').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        delete appState.mistakes[id];
        saveState();
        renderMistakesView();
      });
    });
  }

  // Render Question Bank View
  function renderBankView() {
    const unitFilter = document.getElementById('bank-filter-unit').value;
    const catFilter = document.getElementById('bank-filter-cat').value;
    const statusFilter = document.getElementById('bank-filter-status').value;
    const query = (document.getElementById('bank-search-input').value || '').trim().toLowerCase();
    const seenSet = new Set(appState.seenIds);

    const filtered = BANK.filter((q) => {
      if (unitFilter !== 'ALL' && q.unit !== unitFilter) return false;
      if (catFilter !== 'ALL' && q.category !== catFilter) return false;
      if (statusFilter === 'SEEN' && !seenSet.has(q.id)) return false;
      if (statusFilter === 'UNSEEN' && seenSet.has(q.id)) return false;
      if (query) {
        const hay = `${q.id} ${q.question} ${q.passage || ''} ${q.explanation || ''} ${JSON.stringify(q.options || {})}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    const container = document.getElementById('bank-list-container');
    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state">找不到符合條件的題目。</div>`;
      return;
    }

    // Show up to 100 items at once for fast rendering
    const slice = filtered.slice(0, 100);
    container.innerHTML =
      `<div style="font-size:0.88rem;color:#64748b;margin-bottom:0.5rem;">共找到 ${filtered.length} 題（顯示前 ${slice.length} 題）</div>` +
      slice.map((q, idx) => renderReviewCardHtml(q, idx + 1, null, false)).join('');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatStemHtml(str) {
    const escaped = escapeHtml(str);
    return escaped
      // Cloze blank in stem like ___(1)___
      .replace(/___\((\d+)\)___/g, '<span class="cloze-blank active-blank">____($1)____</span>')
      // Word fill-in-the-blank like d_____y or a_____
      .replace(/\b([A-Za-z]+)_____([A-Za-z]*)/g, '<span class="word-blank-hint">$1<span class="word-blank-line">____</span>$2</span>')
      // Standard standalone blank _____
      .replace(/_____/g, '<span class="blank-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>');
  }

  // Event Listeners Setup
  function initEvents() {
    // Top navigation
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
    document.getElementById('nav-home').addEventListener('click', () => switchView('dashboard'));
    document.getElementById('card-goto-mistakes').addEventListener('click', () => switchView('mistakes'));

    // Start Standard 40-question Mixed Quiz (U3 + U4 + Review2)
    function startStandardMixedQuiz() {
      const qs = sampleQuestions({
        units: ['U3', 'U4', 'Review2'],
        categories: ['字彙選擇', '文法選擇', '對話與完成句子', '克漏字測驗', '文意字彙'],
        targetCount: 40
      });
      startQuizSession({
        mode: 'mixed',
        title: `第 ${appState.roundsDone + 1} 回 U3・U4・Review2 混合練習`,
        questions: qs
      });
    }

    document.getElementById('btn-start-mixed').addEventListener('click', startStandardMixedQuiz);
    document.getElementById('btn-sum-next-round').addEventListener('click', startStandardMixedQuiz);

    // Start Custom Quiz
    document.getElementById('btn-start-custom').addEventListener('click', () => {
      const units = Array.from(document.querySelectorAll('input[name="unit-filter"]:checked')).map(
        (el) => el.value
      );
      const categories = Array.from(document.querySelectorAll('input[name="cat-filter"]:checked')).map(
        (el) => el.value
      );
      const countEl = document.querySelector('input[name="target-count"]:checked');
      const targetCount = countEl ? parseInt(countEl.value, 10) : 40;

      if (units.length === 0 || categories.length === 0) {
        alert('請至少勾選一個單元與一種題型！');
        return;
      }

      const qs = sampleQuestions({ units, categories, targetCount });
      startQuizSession({
        mode: 'custom',
        title: `自訂混合練習 (${qs.length} 題)`,
        questions: qs
      });
    });

    // Quick practice mistakes from dashboard or mistakes view
    function startMistakesQuiz() {
      const unitFilter = document.getElementById('mistake-filter-unit')?.value || 'ALL';
      const catFilter = document.getElementById('mistake-filter-cat')?.value || 'ALL';

      const mistakePool = BANK.filter((q) => {
        if (!appState.mistakes[q.id]) return false;
        if (unitFilter !== 'ALL' && q.unit !== unitFilter) return false;
        if (catFilter !== 'ALL' && q.category !== catFilter) return false;
        return true;
      });

      if (mistakePool.length === 0) {
        alert('目前沒有待複習的錯題！');
        return;
      }

      const blocks = shuffleArray(buildAtomicBlocks(mistakePool));
      const picked = [];
      for (const b of blocks) {
        if (picked.length < 40) picked.push(...b);
      }

      startQuizSession({
        mode: 'mistakes',
        title: `錯題專區重練 (${picked.length} 題)`,
        questions: picked
      });
    }

    document.getElementById('btn-quick-mistakes').addEventListener('click', () => {
      document.getElementById('mistake-filter-unit').value = 'ALL';
      document.getElementById('mistake-filter-cat').value = 'ALL';
      startMistakesQuiz();
    });
    document.getElementById('btn-practice-all-mistakes').addEventListener('click', startMistakesQuiz);

    // Fill-in-the-blank submit
    document.getElementById('btn-submit-fill').addEventListener('click', () => {
      const q = currentQuiz.questions[currentQuiz.currentIndex];
      const val = document.getElementById('fill-answer-input').value;
      if (!val.trim()) {
        alert('請先輸入英文單字答案！');
        return;
      }
      handleUserAnswer(q, val);
    });

    document.getElementById('fill-answer-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = currentQuiz.questions[currentQuiz.currentIndex];
        if (currentQuiz.responses[q.id]) {
          // If already answered, pressing Enter moves to next question
          goNextOrFinish();
        } else {
          document.getElementById('btn-submit-fill').click();
        }
      }
    });

    // Keyboard shortcuts (1-4 or A-D for MCQ, Enter/RightArrow for Next)
    window.addEventListener('keydown', (e) => {
      const quizSec = document.getElementById('view-quiz');
      if (!quizSec.classList.contains('active')) return;
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;

      const q = currentQuiz.questions[currentQuiz.currentIndex];
      if (!q) return;
      const resp = currentQuiz.responses[q.id];

      if (!resp && (q.type === 'mcq' || q.type === 'cloze')) {
        const keyMap = {
          '1': 'A', '2': 'B', '3': 'C', '4': 'D',
          'a': 'A', 'b': 'B', 'c': 'C', 'd': 'D',
          'A': 'A', 'B': 'B', 'C': 'C', 'D': 'D'
        };
        if (keyMap[e.key]) {
          e.preventDefault();
          handleUserAnswer(q, keyMap[e.key]);
        }
      } else if (resp && (e.key === 'Enter' || e.key === 'ArrowRight')) {
        e.preventDefault();
        goNextOrFinish();
      }
    });

    function goNextOrFinish() {
      if (currentQuiz.currentIndex < currentQuiz.questions.length - 1) {
        currentQuiz.currentIndex += 1;
        renderCurrentQuestion();
      } else {
        finishQuizSession();
      }
    }

    document.getElementById('btn-prev-q').addEventListener('click', () => {
      if (currentQuiz.currentIndex > 0) {
        currentQuiz.currentIndex -= 1;
        renderCurrentQuestion();
      }
    });

    document.getElementById('btn-next-q').addEventListener('click', goNextOrFinish);
    document.getElementById('btn-finish-quiz').addEventListener('click', finishQuizSession);

    document.getElementById('btn-quit-quiz').addEventListener('click', () => {
      const answeredCount = Object.keys(currentQuiz.responses).length;
      if (answeredCount > 0 && answeredCount < currentQuiz.questions.length) {
        if (!confirm('本回練習尚未全部作答完畢，確定要提前結束並返回首頁嗎？（已作答的題目與錯題仍會保留）')) {
          return;
        }
      }
      switchView('dashboard');
    });

    document.getElementById('btn-sum-home').addEventListener('click', () => switchView('dashboard'));

    // Reset cycle seenIds
    document.getElementById('btn-reset-cycle').addEventListener('click', () => {
      if (confirm('確定要將本輪「已出過題目」的紀錄歸零嗎？這會讓所有 442 題重新納入未出題池中。')) {
        appState.seenIds = [];
        appState.cycle = 1;
        saveState();
        renderDashboard();
      }
    });

    // Clear history
    document.getElementById('btn-clear-history').addEventListener('click', () => {
      if (confirm('確定要清除最近的練習回數與答題率統計嗎？（錯題區不會被清除）')) {
        appState.history = [];
        appState.roundsDone = 0;
        appState.totalAnswered = 0;
        appState.totalCorrect = 0;
        saveState();
        renderDashboard();
      }
    });

    // Clear mistakes
    document.getElementById('btn-clear-all-mistakes').addEventListener('click', () => {
      if (Object.keys(appState.mistakes).length === 0) return;
      if (confirm('確定要清空錯題區的所有錯題嗎？')) {
        appState.mistakes = {};
        saveState();
        renderMistakesView();
      }
    });

    document.getElementById('chk-auto-remove-mistake').addEventListener('change', (e) => {
      appState.autoRemoveMistake = e.target.checked;
      saveState();
    });

    // Filters
    document.getElementById('mistake-filter-unit').addEventListener('change', renderMistakesView);
    document.getElementById('mistake-filter-cat').addEventListener('change', renderMistakesView);
    document.getElementById('bank-filter-unit').addEventListener('change', renderBankView);
    document.getElementById('bank-filter-cat').addEventListener('change', renderBankView);
    document.getElementById('bank-filter-status').addEventListener('change', renderBankView);
    document.getElementById('bank-search-input').addEventListener('input', renderBankView);
  }

  initEvents();
  renderDashboard();
})();
