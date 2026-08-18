/**
 * PersonalityOnboarding — cold-start personality setup UI component.
 *
 * Renders a multi-step onboarding flow inside the settings page:
 *   Step 1: Choose from 8 predefined personality templates
 *   Step 2: Answer 6 scenario questions (one per dimension) to fine-tune
 *   Step 3: Preview hexagon + generated AGENT.md text, confirm to save
 *
 * Pure vanilla TS + DOM. Follows echoink-settings-* design system.
 */

import {
  PERSONALITY_TEMPLATES,
  TRAIT_DIMENSIONS,
  type TraitDimension,
  type PersonalityTemplate
} from "../harness/memory/personal-memory-contracts";
import { renderTraitHexagon } from "./trait-hexagon";

// ---------------------------------------------------------------------------
// Scenario questions for fine-tuning
// ---------------------------------------------------------------------------

interface ScenarioQuestion {
  readonly dimension: TraitDimension;
  readonly prompt: string;
  readonly optionA: { label: string; score: number }; // left pole
  readonly optionB: { label: string; score: number }; // right pole
}

const SCENARIO_QUESTIONS_ZH: readonly ScenarioQuestion[] = [
  {
    dimension: "tempo",
    prompt: "你纠结两个方案时，希望 Agent 怎么做？",
    optionA: { label: "三分钟给结论，先跑起来再说", score: 0.9 },
    optionB: { label: "先列清利弊再慢慢说", score: 0.15 }
  },
  {
    dimension: "energy",
    prompt: "聊天时你更喜欢哪种氛围？",
    optionA: { label: "热情主动，偶尔起个新话题", score: 0.85 },
    optionB: { label: "安静专注，只回应我问的", score: 0.15 }
  },
  {
    dimension: "mind",
    prompt: "讨论一个新想法时，你希望 Agent 怎么反应？",
    optionA: { label: "发散联想，帮我打开思路", score: 0.85 },
    optionB: { label: "就事论事，聚焦可行性", score: 0.2 }
  },
  {
    dimension: "warmth",
    prompt: "Agent 指出你的方案有问题时，你希望它怎么说？",
    optionA: { label: "直接指出，不用绕弯子", score: 0.2 },
    optionB: { label: "先肯定再建议，照顾感受", score: 0.8 }
  },
  {
    dimension: "order",
    prompt: "输出格式你更偏好哪种？",
    optionA: { label: "结构化列表、表格、分步骤", score: 0.85 },
    optionB: { label: "自然段落，像聊天一样", score: 0.2 }
  },
  {
    dimension: "stance",
    prompt: "你和 Agent 意见不同时，你希望它怎么做？",
    optionA: { label: "以我为准，配合执行", score: 0.15 },
    optionB: { label: "坚持自己的判断，据理力争", score: 0.8 }
  }
];

const SCENARIO_QUESTIONS_EN: readonly ScenarioQuestion[] = [
  {
    dimension: "tempo",
    prompt: "When you're torn between two options, how should Agent respond?",
    optionA: { label: "Give a quick answer in 3 minutes, iterate later", score: 0.9 },
    optionB: { label: "List pros and cons first, then decide", score: 0.15 }
  },
  {
    dimension: "energy",
    prompt: "What chat atmosphere do you prefer?",
    optionA: { label: "Enthusiastic, occasionally starts new topics", score: 0.85 },
    optionB: { label: "Quiet and focused, only answers what I ask", score: 0.15 }
  },
  {
    dimension: "mind",
    prompt: "When discussing a new idea, how should Agent react?",
    optionA: { label: "Brainstorm freely, expand my thinking", score: 0.85 },
    optionB: { label: "Stay practical, focus on feasibility", score: 0.2 }
  },
  {
    dimension: "warmth",
    prompt: "When Agent finds issues with your plan, how should it tell you?",
    optionA: { label: "Point it out directly, no sugarcoating", score: 0.2 },
    optionB: { label: "Acknowledge first, then suggest gently", score: 0.8 }
  },
  {
    dimension: "order",
    prompt: "What output format do you prefer?",
    optionA: { label: "Structured lists, tables, step-by-step", score: 0.85 },
    optionB: { label: "Natural paragraphs, conversational style", score: 0.2 }
  },
  {
    dimension: "stance",
    prompt: "When you and Agent disagree, what should it do?",
    optionA: { label: "Follow my lead, cooperate", score: 0.15 },
    optionB: { label: "Stand its ground, argue with evidence", score: 0.8 }
  }
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface OnboardingState {
  readonly selectedTemplateId: string | null;
  readonly scores: Record<TraitDimension, number>;
  readonly currentStep: number; // 0=templates, 1=questions, 2=preview
  readonly currentQuestionIndex: number;
}

function createInitialState(): OnboardingState {
  const scores: Record<string, number> = {};
  for (const dim of TRAIT_DIMENSIONS) scores[dim] = 0.5;
  return {
    selectedTemplateId: null,
    scores: scores as Record<TraitDimension, number>,
    currentStep: 0,
    currentQuestionIndex: 0
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface OnboardingCallbacks {
  readonly onComplete: (scores: Readonly<Record<TraitDimension, number>>, templateId: string) => void;
  readonly onCancel: () => void;
}

/**
 * Render the full onboarding flow into a container.
 */
export function renderPersonalityOnboarding(
  container: HTMLElement,
  zh: boolean,
  callbacks: OnboardingCallbacks
): void {
  let state = createInitialState();
  const questions = zh ? SCENARIO_QUESTIONS_ZH : SCENARIO_QUESTIONS_EN;

  function rerender(): void {
    container.empty();
    switch (state.currentStep) {
      case 0: renderTemplateStep(container, zh, questions); break;
      case 1: renderQuestionStep(container, zh, questions); break;
      case 2: renderPreviewStep(container, zh, callbacks); break;
    }
  }

  function selectTemplate(template: PersonalityTemplate): void {
    const scores: Record<string, number> = {};
    for (const dim of TRAIT_DIMENSIONS) {
      scores[dim] = template.scores[dim];
    }
    state = {
      ...state,
      selectedTemplateId: template.id,
      scores: scores as Record<TraitDimension, number>,
      currentStep: 1,
      currentQuestionIndex: 0
    };
    rerender();
  }

  function answerQuestion(score: number): void {
    const q = questions[state.currentQuestionIndex];
    const newScores = { ...state.scores, [q.dimension]: score };
    const nextIndex = state.currentQuestionIndex + 1;
    if (nextIndex >= questions.length) {
      state = { ...state, scores: newScores as Record<TraitDimension, number>, currentStep: 2 };
    } else {
      state = { ...state, scores: newScores as Record<TraitDimension, number>, currentQuestionIndex: nextIndex };
    }
    rerender();
  }

  function goBack(): void {
    if (state.currentStep === 1 && state.currentQuestionIndex > 0) {
      state = { ...state, currentQuestionIndex: state.currentQuestionIndex - 1 };
    } else if (state.currentStep === 1 && state.currentQuestionIndex === 0) {
      state = { ...state, currentStep: 0 };
    } else if (state.currentStep === 2) {
      state = { ...state, currentStep: 1, currentQuestionIndex: questions.length - 1 };
    }
    rerender();
  }

  // Expose goBack for external navigation if needed
  (container as HTMLElement & { __onboardingGoBack?: () => void }).__onboardingGoBack = goBack;

  rerender();

  // --- Step renderers ---

  function renderTemplateStep(el: HTMLElement, isZh: boolean, _qs: readonly ScenarioQuestion[]): void {
    const wrapper = el.createDiv({ cls: "echoink-onboarding" });

    const header = wrapper.createDiv({ cls: "echoink-onboarding-header" });
    header.createEl("h3", {
      cls: "echoink-onboarding-title",
      text: isZh ? "选择人格模板" : "Choose a personality template"
    });
    header.createDiv({
      cls: "echoink-onboarding-subtitle",
      text: isZh
        ? "选一个最接近你期望的风格，之后可以通过情境题微调。"
        : "Pick the closest match, then fine-tune with scenario questions."
    });

    const grid = wrapper.createDiv({ cls: "echoink-onboarding-template-grid" });
    for (const template of PERSONALITY_TEMPLATES) {
      const card = grid.createEl("button", {
        cls: "echoink-onboarding-template-card",
        attr: { type: "button" }
      });
      card.createDiv({ cls: "echoink-onboarding-template-name", text: template.label });
      card.createDiv({ cls: "echoink-onboarding-template-desc", text: template.description });

      // Mini hexagon preview
      const miniStage = card.createDiv({ cls: "echoink-onboarding-template-preview" });
      renderTraitHexagon(miniStage, template.scores, { size: 100, rings: 3 });

      card.onclick = () => selectTemplate(template);
    }

    const footer = wrapper.createDiv({ cls: "echoink-onboarding-footer" });
    const cancelBtn = footer.createEl("button", {
      cls: "echoink-onboarding-btn echoink-onboarding-btn-ghost",
      text: isZh ? "跳过，稍后设置" : "Skip, set up later",
      attr: { type: "button" }
    });
    cancelBtn.onclick = callbacks.onCancel;
  }

  function renderQuestionStep(el: HTMLElement, isZh: boolean, qs: readonly ScenarioQuestion[]): void {
    const wrapper = el.createDiv({ cls: "echoink-onboarding" });
    const q = qs[state.currentQuestionIndex];

    // Progress bar
    const progress = wrapper.createDiv({ cls: "echoink-onboarding-progress" });
    const bar = progress.createDiv({ cls: "echoink-onboarding-progress-bar" });
    bar.style.width = `${((state.currentQuestionIndex) / qs.length) * 100}%`;
    progress.createDiv({
      cls: "echoink-onboarding-progress-text",
      text: `${state.currentQuestionIndex + 1} / ${qs.length}`
    });

    // Question
    const questionArea = wrapper.createDiv({ cls: "echoink-onboarding-question" });
    questionArea.createDiv({ cls: "echoink-onboarding-question-prompt", text: q.prompt });

    // Options
    const options = wrapper.createDiv({ cls: "echoink-onboarding-options" });
    const btnA = options.createEl("button", {
      cls: "echoink-onboarding-option-btn",
      attr: { type: "button" }
    });
    btnA.createDiv({ cls: "echoink-onboarding-option-label", text: `A. ${q.optionA.label}` });
    btnA.onclick = () => answerQuestion(q.optionA.score);

    const btnB = options.createEl("button", {
      cls: "echoink-onboarding-option-btn",
      attr: { type: "button" }
    });
    btnB.createDiv({ cls: "echoink-onboarding-option-label", text: `B. ${q.optionB.label}` });
    btnB.onclick = () => answerQuestion(q.optionB.score);

    // Navigation
    const nav = wrapper.createDiv({ cls: "echoink-onboarding-footer" });
    const backBtn = nav.createEl("button", {
      cls: "echoink-onboarding-btn echoink-onboarding-btn-ghost",
      text: isZh ? "上一步" : "Back",
      attr: { type: "button" }
    });
    backBtn.onclick = goBack;
  }

  function renderPreviewStep(el: HTMLElement, isZh: boolean, cbs: OnboardingCallbacks): void {
    const wrapper = el.createDiv({ cls: "echoink-onboarding" });

    const header = wrapper.createDiv({ cls: "echoink-onboarding-header" });
    header.createEl("h3", {
      cls: "echoink-onboarding-title",
      text: isZh ? "预览你的人格配置" : "Preview your personality"
    });
    header.createDiv({
      cls: "echoink-onboarding-subtitle",
      text: isZh
        ? "确认无误后点击「完成设置」，Agent 将按此人格与你互动。"
        : "Click 'Complete Setup' to apply. Agent will interact with you using this personality."
    });

    // Hexagon preview
    const stage = wrapper.createDiv({ cls: "echoink-onboarding-preview-stage" });
    renderTraitHexagon(stage, state.scores, {
      size: 240,
      rings: 4,
      baselineScores: state.selectedTemplateId
        ? PERSONALITY_TEMPLATES.find((t) => t.id === state.selectedTemplateId)?.scores
        : undefined
    });

    // Score summary
    const summary = wrapper.createDiv({ cls: "echoink-onboarding-score-summary" });
    const labels: Record<TraitDimension, string> = {
      tempo: isZh ? "节奏" : "Tempo",
      energy: isZh ? "能量" : "Energy",
      mind: isZh ? "思维" : "Mind",
      warmth: isZh ? "温度" : "Warmth",
      order: isZh ? "秩序" : "Order",
      stance: isZh ? "立场" : "Stance"
    };
    for (const dim of TRAIT_DIMENSIONS) {
      const row = summary.createDiv({ cls: "echoink-onboarding-score-row" });
      row.createSpan({ cls: "echoink-onboarding-score-label", text: labels[dim] });
      const barContainer = row.createDiv({ cls: "echoink-onboarding-score-bar-container" });
      const barFill = barContainer.createDiv({ cls: "echoink-onboarding-score-bar-fill" });
      barFill.style.width = `${state.scores[dim] * 100}%`;
      row.createSpan({
        cls: "echoink-onboarding-score-value",
        text: `${Math.round(state.scores[dim] * 100)}%`
      });
    }

    // Actions
    const actions = wrapper.createDiv({ cls: "echoink-onboarding-footer" });
    const backBtn = actions.createEl("button", {
      cls: "echoink-onboarding-btn echoink-onboarding-btn-ghost",
      text: isZh ? "返回调整" : "Go back",
      attr: { type: "button" }
    });
    backBtn.onclick = goBack;

    const confirmBtn = actions.createEl("button", {
      cls: "echoink-onboarding-btn echoink-onboarding-btn-primary",
      text: isZh ? "完成设置" : "Complete Setup",
      attr: { type: "button" }
    });
    confirmBtn.onclick = () => {
      cbs.onComplete(state.scores, state.selectedTemplateId ?? "custom");
    };
  }
}
