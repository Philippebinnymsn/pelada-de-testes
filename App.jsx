import React, { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabaseClient.js";

/* =========================================================================
   PELADA — sorteador de times equilibrados
   Armazenamento: Supabase (Postgres + Storage). O cadastro de jogadores é
   compartilhado entre qualquer pessoa que acesse o site; só administradores
   logados (Supabase Auth) podem cadastrar/editar/excluir jogadores — a regra
   de verdade vive nas políticas de RLS em supabase/schema.sql, o app é só a
   interface por cima disso. Configuração de uma pelada específica (seleção,
   regras) continua vivendo só na sessão do navegador.
   ========================================================================= */

// Converte entre o formato de coluna do Postgres (snake_case) e o formato
// que o resto do app usa (camelCase), pra não precisar reescrever toda a UI.
function rowToPlayer(row) {
  return {
    id: row.id,
    name: row.name,
    nickname: row.nickname,
    rating: row.rating,
    isGK: row.is_gk,
    photo: row.photo_url,
    photoPosition: row.photo_position,
    cover1: row.cover1_url,
    cover2: row.cover2_url,
    cover3: row.cover3_url,
    cover4: row.cover4_url,
    cover5: row.cover5_url,
    cover1Position: row.cover1_position || "50% 50%",
    cover2Position: row.cover2_position || "50% 50%",
    cover3Position: row.cover3_position || "50% 50%",
    cover4Position: row.cover4_position || "50% 50%",
    cover5Position: row.cover5_position || "50% 50%",
    position: row.position,
    favoriteTeam: row.favorite_team,
    shirtNumber: row.shirt_number ?? null,
    userId: row.user_id ?? null,
    instagram: row.instagram ?? null,
    membershipType: row.membership_type ?? "avulso",
    membershipInterestAt: row.membership_interest_at ?? null,
    membershipInterestOrder: row.membership_interest_order ?? null,
    tempReplacesPlayerId: row.temp_replaces_player_id ?? null,
    tempStartedAt: row.temp_started_at ?? null,
    membershipInterestBy: row.membership_interest_by ?? null,
    membershipReportedMonth: row.membership_reported_month ?? null,
  };
}
function playerToRow(p) {
  return {
    name: p.name,
    nickname: p.nickname,
    rating: p.rating,
    is_gk: p.isGK,
    photo_url: p.photo,
    photo_position: p.photoPosition,
    cover1_url: p.cover1,
    cover2_url: p.cover2,
    cover3_url: p.cover3,
    cover4_url: p.cover4,
    cover5_url: p.cover5,
    cover1_position: p.cover1Position || "50% 50%",
    cover2_position: p.cover2Position || "50% 50%",
    cover3_position: p.cover3Position || "50% 50%",
    cover4_position: p.cover4Position || "50% 50%",
    cover5_position: p.cover5Position || "50% 50%",
    position: p.position,
    favorite_team: p.favoriteTeam,
    ...(p.shirtNumber != null || p.shirtNumberClear ? { shirt_number: p.shirtNumber ?? null } : {}),
    instagram: p.instagram,
    ...(p.membershipType ? { membership_type: p.membershipType } : {}),
  };
}

const isMensalista = (player) => player?.membershipType === "mensalista";
// Mensalista temporário: interessado que o admin colocou no lugar de um
// mensalista (que virou avulso). Guarda de quem é a vaga.
const isTempMensalista = (player) => isMensalista(player) && !!player?.tempReplacesPlayerId;
// Chave do mês corrente no formato usado pra controle de pagamento de
// mensalidade ("YYYY-MM") — cada mês tem seu próprio registro de pago/não.
const currentMonthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const MONTH_LABELS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
const monthKeyLabel = (key) => {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_LABELS[m - 1]}/${y}`;
};

// A partir de segunda-feira 16h (horário de Brasília), a lista de presença
// aparece direto na home — antes disso fica escondida atrás do botão
// "LISTA ABERTA · ACESSE AQUI!". Usa o fuso de Brasília explicitamente pra
// não depender do fuso do aparelho de quem está olhando.
const isMondayAfternoonBRT = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return weekday === "Mon" && hour >= 16;
};

// A Pelada 4K é sempre numa segunda-feira — a página da lista de presença
// mostra sempre a data da próxima segunda (a de hoje, se hoje já for
// segunda), calculada no fuso de Brasília.
const MONTHS_PT_ABBR = [
  "JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ",
];
const nextMondayLabelBRT = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const weekdayIdx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")];
  const daysUntilMonday = (8 - weekdayIdx) % 7; // já é segunda → 0 (mostra hoje)
  // Data "neutra" ao meio-dia UTC só pra somar dias sem tropeçar em DST.
  const target = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  target.setUTCDate(target.getUTCDate() + daysUntilMonday);
  const dayNum = String(target.getUTCDate()).padStart(2, "0");
  const monthNum = String(target.getUTCMonth() + 1).padStart(2, "0");
  return {
    day: dayNum,
    dayMonth: `${dayNum}/${monthNum}`,
    monthAbbr: MONTHS_PT_ABBR[target.getUTCMonth()],
  };
};

// A partir de 0h de terça-feira (horário de Brasília) — logo depois da
// pelada de segunda — o botão "ESCALAÇÃO DEFINIDA" para de animar e vira o
// cartão cinza de "pelada concluída", até a próxima escalação ser publicada.
const isEscalacaoConcludedBRT = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  // "Pelada concluída" só depois da segunda (terça/quarta). Escalação recém
  // publicada de quinta a domingo é da próxima pelada, não da que passou.
  return weekday === "Tue" || weekday === "Wed";
};
// Última quarta 20h (Brasília) já passada. Escalação publicada depois disso
// fica visível até a próxima quarta 20h, mesmo de quinta a domingo.
const lastWednesday8pmBRT = (now = new Date()) => {
  const OFF = 3 * 3600 * 1000;
  const b = new Date(now.getTime() - OFF);
  let d = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), 20, 0, 0));
  while (d.getUTCDay() !== 3 || d.getTime() > b.getTime()) d = new Date(d.getTime() - 86400000);
  return new Date(d.getTime() + OFF);
};
const isEscalacaoFreshBRT = (updatedAt, now = new Date()) =>
  !!updatedAt && new Date(updatedAt) > lastWednesday8pmBRT(now);

// A pelada é a primeira do mês? (segunda-feira com dia 1 a 7). Usa a data
// agendada da pelada; sem data, a próxima segunda (dia da pelada semanal).
const isFirstPeladaOfMonth = (pelada) => {
  if (pelada?.scheduledFor) {
    const day = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", day: "numeric" }).format(
        new Date(pelada.scheduledFor)
      )
    );
    return day <= 7;
  }
  return Number(nextMondayLabelBRT().day) <= 7;
};

// O botão "ESCALAÇÃO DEFINIDA" (e o cartão "PELADA CONCLUÍDA" que ele vira
// a partir de terça 0h) some da home sozinho a partir de quarta-feira 20h
// (horário de Brasília) — a lista sorteada continua salva (o admin ainda
// pode excluir/publicar outra), só some da tela até a próxima vez que o
// admin publicar um sorteio novo.
const isBeforeWednesday8pmBRT = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (weekday === "Wed" && hour >= 20) return false;
  if (weekday === "Thu" || weekday === "Fri" || weekday === "Sat" || weekday === "Sun") return false;
  return true;
};

// A partir de segunda-feira 13h (horário de Brasília) — dia da própria
// pelada — a lista principal fecha: o sistema coloca como ausente quem não
// respondeu, sobe os avulsos da fila e quem "retira a ausência" depois disso
// já pode encontrar a vaga ocupada, então perde a prioridade de mensalista.
const MONDAY_CUTOFF_HOUR = 13;
const isMondayBRT = (now = new Date()) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(now) === "Mon";
const isAfterMonday12hBRT = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return weekday === "Mon" && hour >= MONDAY_CUTOFF_HOUR;
};
// PIX padrão — usado só enquanto o admin ainda não escolheu um "PIX do mês"
// (app_settings, chave 'pix_settings'). Depois disso, todas as cobranças
// mostram o PIX ativo escolhido pelo admin.
const PIX_INFO = {
  id: "pix-padrao",
  name: "Felipe Freitas",
  key: "duostudiophoto@gmail.com",
};
const activePixFrom = (settings) => {
  const accounts = settings?.accounts || [];
  return accounts.find((a) => a.id === settings?.activeId) || accounts[0] || PIX_INFO;
};
// Cada conta PIX é um CAIXA no controle financeiro. Sem nenhum PIX salvo
// ainda, existe só o PIX padrão (Felipe Freitas).
const pixAccountsOf = (settings) => {
  const accounts = settings?.accounts || [];
  return accounts.length > 0 ? accounts : [PIX_INFO];
};
// Caixa dos registros antigos (antes de existir caixa por PIX): o do PIX
// padrão do Felipe — mesmo que ele já tenha sido salvo na lista com outro id.
const legacyCaixaIdOf = (settings) => {
  const accounts = pixAccountsOf(settings);
  const felipe = accounts.find((a) => (a.key || "").trim().toLowerCase() === PIX_INFO.key);
  return felipe ? felipe.id : PIX_INFO.id;
};
const PAYMENT_MESSAGES = {
  avulso: {
    title: "Bem-vindo(a) à Pelada 4K!",
    amount: "R$ 30,00",
    body: "Favor efetuar o pagamento da sua participação para confirmar sua presença:",
  },
  mensalista: {
    title: "Bem-vindo(a) à Pelada 4K!",
    amount: "R$ 109,20",
    body: "Favor efetuar o pagamento da sua mensalidade para confirmar sua presença como mensalista:",
  },
  // Alertas enviados à mão por um admin (botão ENVIAR ALERTA)
  mensalista_alerta: {
    title: "Pagamento pendente!",
    amount: "R$ 109,20",
    body: "Falta fazer o pagamento da sua mensalidade deste mês. Sem o pagamento você corre o risco de perder a sua vaga de mensalista:",
    note: "Caso já tenha efetuado o pagamento, envie o comprovante para algum administrador.",
  },
  avulso_alerta: {
    title: "Pagamento pendente!",
    amount: "R$ 30,00",
    body: "Falta fazer o pagamento do PIX avulso da pelada. Sem o pagamento você corre o risco de perder a sua vaga na lista:",
    note: "Caso já tenha efetuado o pagamento, envie o comprovante para algum administrador.",
  },
  // Pop-up da primeira pelada do mês, quando o mensalista confirma presença
  mensalista_primeira: {
    title: "Primeira pelada do mês!",
    amount: "R$ 109,20",
    body: "Está na hora de pagar a mensalidade deste mês. Se ainda não pagou, faça o PIX abaixo:",
    note: "Caso já tenha efetuado o pagamento, envie o comprovante para algum administrador.",
  },
};
// Mesmos valores acima, em número — usados pra somar o controle financeiro.
const AVULSO_VALUE = 30;
const MENSALIDADE_VALUE = 109.2;
const formatBRL = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const AVULSO_WAITING_MESSAGE = {
  title: "Atenção jogador!",
  lines: [
    "Fique atento ao fechamento da lista. Caso algum mensalista não confirme presença, por ordem, o seu nome pode subir para a lista oficial da Pelada 4K.",
    "Sua presença só será confirmada mediante pagamento do Avulso!",
    "Ao subirmos seu nome para a lista, aparecerá para você a mensagem com a chave PIX, que deverá ser paga antes da pelada.",
  ],
};

// Pop-up pro avulso cujo nome subiu pra lista ANTES das 12h de segunda —
// ainda não é hora de cobrar: a mensagem com a chave PIX só aparece às 12h
// de segunda, quando a lista fecha com todos os avulsos e mensalistas
// confirmados. Até lá, só um aviso pra ele ficar de olho.
const AVULSO_PROMOTED_EARLY_MESSAGE = {
  title: "Seu nome subiu na lista!",
  lines: [
    "Você já está pré-convocado para a próxima Pelada 4K — mas fique de olho: a lista fecha às 13h de segunda-feira.",
    "A cobrança do Avulso (com a chave PIX) vai aparecer aqui assim que a lista fechar. É nesse horário que você deve efetuar o pagamento.",
  ],
};

// Pop-up pro mensalista que marcou ausência e "retirou a ausência" depois
// do corte de segunda 12h — avisa que a vaga já foi ocupada por um avulso.
const LATE_REJOIN_MESSAGE = {
  title: "Prioridade de mensalista encerrada!",
  lines: [
    "Já passou das 13h de segunda, horário em que a lista abre pra todo mundo — se você não estava confirmado até lá, sua vaga garantida de mensalista não vale mais pra essa pelada.",
    "Sua confirmação entrou no fim da fila de avulsos, não direto em CONFIRMADOS.",
    "Se sobrar vaga (outro mensalista faltar), seu nome sobe normalmente, respeitando a ordem da fila.",
  ],
};

// Instagram é guardado sem "@" no banco; aceita o usuário colar com "@",
// espaços, ou o link inteiro (instagram.com/fulano) e limpa pra só o handle.
const cleanInstagramHandle = (s) =>
  (s || "")
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "")
    .trim();
const instagramUrl = (handle) => `https://instagram.com/${encodeURIComponent(handle)}`;

function rowToPelada(row) {
  return {
    id: row.id,
    scheduledFor: row.scheduled_for,
    location: row.location,
    status: row.status,
    kind: row.kind || "main",
    createdBy: row.created_by,
    createdAt: row.created_at ?? null,
  };
}

// A "lista publicada" é um registro único (mesmo id sempre) — publicar
// substitui a lista anterior automaticamente (upsert), sem precisar de
// permissão de exclusão para isso. Só excluir de vez exige ser admin.
const PUBLISHED_LIST_ID = "00000000-0000-0000-0000-000000000001";
function rowToPublishedList(row) {
  return {
    teams: row.teams,
    considerGK: row.consider_gk,
    diff: row.diff,
    stars: row.stars,
    label: row.label,
    updatedAt: row.updated_at ?? null,
  };
}

// Aviso do admin (popup) — linha de id fixo, igual à lista sorteada:
// publicar um aviso novo substitui o anterior.
const ANNOUNCEMENT_ID = "00000000-0000-0000-0000-000000000002";
function rowToAnnouncement(row) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    mode: row.mode,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
// Cada anúncio publicado carimba a lembrança de "já vi"/"fechei nessa
// sessão" com o próprio created_at — assim, quando o admin publica um aviso
// novo (mesma linha de id fixo), ninguém que já tinha fechado o anterior
// fica sem ver o novo.
const announcementStorageKey = (a) => `pelada4k_announcement_${a.id}_${a.createdAt}`;
function isAnnouncementDismissed(a) {
  if (!a) return true;
  if (a.mode === "until_date") {
    if (a.expiresAt && new Date(a.expiresAt) <= new Date()) return true;
    try {
      return sessionStorage.getItem(announcementStorageKey(a)) === "1";
    } catch {
      return false;
    }
  }
  try {
    return localStorage.getItem(announcementStorageKey(a)) === "1";
  } catch {
    return false;
  }
}
function dismissAnnouncement(a) {
  try {
    const storage = a.mode === "until_date" ? sessionStorage : localStorage;
    storage.setItem(announcementStorageKey(a), "1");
  } catch {
    /* storage indisponível — só não vai lembrar entre visitas */
  }
}

// Escudo oficial da Pelada — enviado pelo usuário, embutido para funcionar offline
const LOGO_DATA_URL = "/assets/logo.png";

// Estadio a noite (referencia enviada pelo usuario) usado como plano de fundo com parallax
const STADIUM_DATA_URL = "/assets/stadium.jpg";

// Estádio + bola em primeiro plano (a mesma foto de referência enviada pelo
// usuário) — usada no card do topo da página da Lista de Presença.
const STADIUM_BALL_DATA_URL = "/assets/stadium-ball.jpg";

const TEAM_COLORS = [
  { key: "preto", label: "Time Preto", emoji: "⚫", color: "#EDEDED" },
  { key: "laranja", label: "Time Laranja", emoji: "🟠", color: "#FF8A3D" },
  { key: "fora", label: "Primeira de Fora", emoji: "⚪", color: "#AFC3D6" },
];

const POSITIONS = [
  { code: "GOLEIRO", label: "Goleiro" },
  { code: "ZAG", label: "Zagueiro" },
  { code: "FIXO", label: "Zagueiro" },
  { code: "VOL", label: "Volante" },
  { code: "MEIA", label: "Meio-campo" },
  { code: "ATA", label: "Atacante" },
  { code: "PIVÔ", label: "Atacante" },
];

// Paleta usada para gerar o "escudo" do time do coração a partir do nome
const SHIELD_PALETTE = ["#3E7BFA", "#E5484D", "#34C77B", "#E4B559", "#8A63D2", "#2FB6C4", "#D9776B", "#6B7A8F"];
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function teamShieldColor(name) {
  return SHIELD_PALETTE[hashStr(name || "?") % SHIELD_PALETTE.length];
}

// Gradiente determinístico (dourado/vinho da marca + variação) usado como capa
// de perfil quando o jogador ainda não tem foto cadastrada
const HERO_GRADIENTS = [
  ["#B8923A", "#3D0D0D"],
  ["#7A1F1F", "#241a06"],
  ["#8A63D2", "#241a06"],
  ["#2FB6C4", "#1a1206"],
  ["#3E7BFA", "#241a06"],
  ["#34C77B", "#1a1206"],
];
function heroGradient(name) {
  return HERO_GRADIENTS[hashStr(name || "?") % HERO_GRADIENTS.length];
}

const uid = (p = "id") =>
  `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// Regras da pelada usam *assim* pra marcar negrito (igual WhatsApp) — troca
// cada trecho entre asteriscos por <strong>, mantendo o resto como texto.
function renderBoldText(text) {
  return text.split(/(\*[^*]+\*)/g).map((part, i) =>
    part.startsWith("*") && part.endsWith("*") && part.length > 1 ? (
      <strong key={i}>{emo(part.slice(1, -1))}</strong>
    ) : (
      <React.Fragment key={i}>{emo(part)}</React.Fragment>
    )
  );
}

// Transição de tela: CORTINA DIAGONAL em todas as páginas e pop-ups. A entrada é
// CSS puro; a saída toca a animação (classe no <body>) e só então fecha.
function fxClose(fn, ms = 420) {
  if (typeof document === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    fn();
    return;
  }
  if (document.body.classList.contains("fx-leaving")) return;
  document.body.classList.add("fx-leaving");
  setTimeout(() => {
    document.body.classList.remove("fx-leaving");
    fn();
  }, ms);
}

// Forma do card (escudo) — definida UMA vez no <body>, fora do React. Antes cada
// tela tinha a sua cópia; quando uma saía de cena, o recorte sumia e os cards
// ficavam quadrados.
if (typeof document !== "undefined" && !document.getElementById("futp-defs")) {
  const holder = document.createElement("div");
  holder.id = "futp-defs";
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  holder.innerHTML =
    '<svg width="0" height="0" focusable="false"><defs><clipPath id="futp" clipPathUnits="objectBoundingBox"><path d="M0.10,0 L0.90,0 Q1,0 1,0.07 L1,0.80 Q1,0.90 0.80,0.945 L0.5,1 L0.20,0.945 Q0,0.90 0,0.80 L0,0.07 Q0,0 0.10,0 Z"/></clipPath></defs></svg>';
  document.body.appendChild(holder);
}

const clampRating = (n) => Math.min(99, Math.max(1, Math.round(Number(n) || 1)));

const starsFilled = (rating) => Math.min(5, Math.max(1, Math.round(rating / (rating > 10 ? 20 : 2))));

// Numeração em emoji (01, 02, ...) usada na lista de presença — o mesmo
// estilo que já circula nos grupos de WhatsApp de pelada.
const DIGIT_EMOJI = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
const numEmoji = (n) =>
  String(n).padStart(2, "0").split("").map((d) => DIGIT_EMOJI[Number(d)]).join("");

const initials = (name) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

// Apelido é o nome de exibição principal quando definido; nome completo fica em segundo plano
const displayName = (p) => p.nickname || p.name;

// Traduz as mensagens de erro do Supabase Auth (sempre em inglês) pra um
// aviso em português que a pessoa entende — sem isso, erros como limite de
// tentativas ou e-mail não confirmado apareciam crus na tela ("For security
// purposes, you can only request this after 53 seconds.") ou, pior, o login
// mostrava sempre "senha incorreta" mesmo quando o problema era outro.
function translateAuthError(message) {
  if (!message) return "Não foi possível concluir. Tente novamente.";
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) {
    return "E-mail ou senha incorretos.";
  }
  if (m.includes("email not confirmed")) {
    return "Seu e-mail ainda não foi confirmado. Confira sua caixa de entrada (e o spam) e clique no link de confirmação antes de entrar.";
  }
  if (m.includes("user already registered") || m.includes("already registered")) {
    return "Já existe uma conta com esse e-mail. Tente entrar, ou toque em \"Esqueci minha senha\" se não lembra a senha.";
  }
  if (m.includes("password should be at least") || m.includes("password is too short")) {
    return "A senha precisa ter pelo menos 6 caracteres.";
  }
  if (m.includes("security purposes") || m.includes("rate limit")) {
    return "Muitas tentativas seguidas. Espere cerca de 1 minuto e tente de novo.";
  }
  if (m.includes("invalid email") || m.includes("unable to validate email")) {
    return "Esse e-mail não parece válido. Confira se digitou certo.";
  }
  if (m.includes("failed to fetch") || m.includes("network")) {
    return "Não foi possível conectar. Verifique sua internet e tente de novo.";
  }
  return message;
}

/* ---------------------------- formatação de nomes ------------------------
   Regra: o "nome" que aparece nos cards (apelido) sempre em CAIXA ALTA; o
   nome completo em formatação normal, com só a primeira letra de cada
   palavra (nome e sobrenome) maiúscula. Formatado no momento de salvar, pra
   valer em qualquer lugar que o texto apareça (cards, listas, WhatsApp). */
const formatDisplayNameValue = (s) =>
  (s || "").trim().replace(/\s+/g, " ").toUpperCase();

const formatFullNameValue = (s) =>
  (s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|\s|-)([a-zà-öø-ÿ])/g, (_, sep, ch) => sep + ch.toUpperCase());

/* ---------------------------- algoritmo de sorteio ---------------------- */

function computeTeamSizes(n, t) {
  const base = Math.floor(n / t);
  const rem = n % t;
  return Array.from({ length: t }, (_, i) => base + (i < rem ? 1 : 0));
}

// Une jogadores em "unidades" (grupos que devem ficar juntos) quando o
// método é 'regras'. Nos demais métodos cada jogador é sua própria unidade.
function buildUnits(selectedPlayers, rules, method) {
  if (method !== "regras") {
    return {
      units: selectedPlayers.map((p) => ({
        ids: [p.id],
        rating: p.rating,
        gk: p.isGK ? 1 : 0,
        size: 1,
      })),
      separatePairs: [],
      error: null,
    };
  }

  const selectedIds = new Set(selectedPlayers.map((p) => p.id));
  const together = rules.filter(
    (r) => r.type === "juntos" && selectedIds.has(r.a) && selectedIds.has(r.b)
  );
  const separate = rules.filter(
    (r) => r.type === "separar" && selectedIds.has(r.a) && selectedIds.has(r.b)
  );

  const parent = {};
  selectedPlayers.forEach((p) => (parent[p.id] = p.id));
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  together.forEach((r) => union(r.a, r.b));

  for (const r of separate) {
    if (find(r.a) === find(r.b)) {
      return { units: [], separatePairs: [], error: "conflito" };
    }
  }

  const groups = {};
  selectedPlayers.forEach((p) => {
    const root = find(p.id);
    if (!groups[root]) groups[root] = [];
    groups[root].push(p);
  });

  const units = Object.values(groups).map((members) => ({
    ids: members.map((m) => m.id),
    rating: members.reduce((s, m) => s + m.rating, 0),
    gk: members.filter((m) => m.isGK).length,
    size: members.length,
    root: find(members[0].id),
  }));

  const separatePairs = separate.map((r) => [find(r.a), find(r.b)]);

  return { units, separatePairs, error: null };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function conflictsWithTeam(unit, team, separatePairs) {
  if (!unit.root || separatePairs.length === 0) return false;
  return team.roots.some((r) =>
    separatePairs.some(
      ([a, b]) => (a === unit.root && b === r) || (b === unit.root && a === r)
    )
  );
}

function assignOnce(units, sizes, considerGK, method, separatePairs) {
  const teams = sizes.map((cap) => ({
    ids: [],
    roots: [],
    rating: 0,
    gk: 0,
    capacity: cap,
  }));

  const place = (unit, team) => {
    team.ids.push(...unit.ids);
    if (unit.root) team.roots.push(unit.root);
    team.rating += unit.rating;
    team.gk += unit.gk;
    team.capacity -= unit.size;
  };

  const feasible = (unit, team) =>
    team.capacity >= unit.size && !conflictsWithTeam(unit, team, separatePairs);

  let remaining = units;

  if (considerGK) {
    const gkUnits = shuffle(remaining.filter((u) => u.gk > 0));
    remaining = remaining.filter((u) => u.gk === 0);
    // Regra especial: com exatamente 2 goleiros e 3 times, eles vão sempre
    // para o Time Preto e o Time Laranja (os 2 primeiros times) — o time
    // "Primeira de Fora" fica sem goleiro fixo nesse caso.
    const restrictToFirstTwo = gkUnits.length === 2 && teams.length === 3;
    for (const u of gkUnits) {
      const pool = restrictToFirstTwo ? teams.slice(0, 2) : teams;
      const options = pool.filter((t) => feasible(u, t));
      if (options.length === 0) return null;
      options.sort((a, b) => a.gk - b.gk || a.rating - b.rating);
      place(u, options[0]);
    }
  }

  let order;
  if (method === "aleatorio") {
    order = shuffle(remaining);
  } else {
    // maior nota primeiro ajuda o equilíbrio guloso; leve aleatoriedade
    // entre unidades de nota parecida garante restarts diferentes
    order = shuffle(remaining).sort((a, b) => b.rating - a.rating);
  }

  for (const u of order) {
    const options = teams.filter((t) => feasible(u, t));
    if (options.length === 0) return null;
    let chosen;
    if (method === "aleatorio") {
      chosen = options[Math.floor(Math.random() * options.length)];
    } else {
      options.sort((a, b) => a.rating - b.rating);
      chosen = options[0];
    }
    place(u, chosen);
  }

  return teams;
}

function generateDraw(selectedPlayers, numTeams, considerGK, method, rules) {
  const sizes = computeTeamSizes(selectedPlayers.length, numTeams);
  const maxCap = Math.max(...sizes);
  const { units, separatePairs, error } = buildUnits(selectedPlayers, rules, method);

  if (error === "conflito") {
    return { error: "Existem regras conflitantes. Revise suas regras antes de sortear." };
  }
  const tooBig = units.find((u) => u.size > maxCap);
  if (tooBig) {
    return {
      error:
        "Um grupo de jogadores que deve ficar junto é maior do que o tamanho de um time. Ajuste as regras ou o número de times.",
    };
  }

  const trials = method === "aleatorio" ? 20 : 350;
  let best = null;
  let bestCost = Infinity;

  for (let i = 0; i < trials; i++) {
    const attempt = assignOnce(units, sizes, considerGK, method, separatePairs);
    if (!attempt) continue;
    const sums = attempt.map((t) => t.rating);
    const cost = Math.max(...sums) - Math.min(...sums);
    if (cost < bestCost) {
      bestCost = cost;
      best = attempt;
    }
    if (method === "aleatorio" || cost === 0) break;
  }

  if (!best) {
    return { error: "Não foi possível formar os times respeitando as regras definidas." };
  }

  const totalGK = selectedPlayers.filter((p) => p.isGK).length;
  let gkMessage = null;
  if (considerGK) {
    if (totalGK === 0) gkMessage = "Nenhum goleiro entre os jogadores selecionados.";
    else if (totalGK < numTeams)
      gkMessage = `Existem apenas ${totalGK} goleiro${totalGK > 1 ? "s" : ""} para ${numTeams} times.`;
  }

  const byId = Object.fromEntries(selectedPlayers.map((p) => [p.id, p]));
  const teams = best.map((t, i) => ({
    ...TEAM_COLORS[i],
    players: t.ids
      .map((id) => byId[id])
      .sort((a, b) => {
        // Com "Considerar goleiros" ativo, o goleiro sempre aparece primeiro
        // na lista do time; entre jogadores de mesmo status, ordena por nota.
        if (considerGK && a.isGK !== b.isGK) return a.isGK ? -1 : 1;
        return b.rating - a.rating;
      }),
    sum: t.rating,
  }));

  const diff = Math.max(...teams.map((t) => t.sum)) - Math.min(...teams.map((t) => t.sum));
  let stars, label;
  if (diff <= 1) [stars, label] = [5, "Excelente"];
  else if (diff <= 3) [stars, label] = [4, "Muito bom"];
  else if (diff <= 6) [stars, label] = [3, "Razoável"];
  else [stars, label] = [2, "Pode melhorar"];

  return { teams, diff, stars, label, gkMessage, considerGK, error: null };
}

/* --------------------------------- UI ----------------------------------- */

function posCode(pos) {
  const t = String(pos || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
  if (!t) return "JOG";
  const map = [["GOLEIRO", "GOL"], ["ZAGUEIRO", "ZAG"], ["LATERAL", "LAT"], ["VOLANTE", "VOL"], ["MEIO", "MEI"], ["MEIA", "MEI"], ["ATACANTE", "ATA"], ["PONTA", "PON"], ["FIXO", "FIX"], ["ALA", "ALA"]];
  for (const [k, v] of map) if (t.startsWith(k)) return v;
  return t.slice(0, 3);
}
function PosTag({ p }) {
  if (p?.isGK) return <span className="pos-gk">GOL<Emo e="🧤" /></span>;
  return <>{posCode(p?.position)}</>;
}
function Star({ filled }) {
  return <span style={{ opacity: filled ? 1 : 0.25 }}><Emo e="★" /></span>;
}
function InstagramIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="4.6" stroke="currentColor" strokeWidth="2" />
      <circle cx="17.6" cy="6.4" r="1.3" fill="currentColor" />
    </svg>
  );
}

// Link do Instagram do jogador — ícone + "@handle", abre o perfil numa aba
// nova. stopPropagation pra não disparar o clique do card por baixo.
function InstagramLink({ handle, className = "" }) {
  if (!handle) return null;
  return (
    <a
      href={instagramUrl(handle)}
      target="_blank"
      rel="noopener noreferrer"
      className={`instagram-link ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      <InstagramIcon size={15} />
      <span>@{handle}</span>
    </a>
  );
}

// Selo de tipo de membro: mensalista (medalha de ouro) ou avulso (texto simples).
function MembershipBadge({ player, className = "", short = false }) {
  if (isMensalista(player)) {
    const temp = isTempMensalista(player);
    return (
      <span className={`membership-badge membership-badge-mensalista ${className}`}>
        <span className="membership-badge-icon" aria-hidden="true"><Emo e={temp ? "🔄" : "🏅"} /></span>
        {temp ? (short ? "Temporário" : "Membro Mensalista Temporário") : short ? "Mensalista" : "Membro Mensalista"}
      </span>
    );
  }
  return (
    <span className={`membership-badge membership-badge-avulso ${className}`}>
      <span className="membership-badge-icon" aria-hidden="true"><Emo e="🎟" /></span>
      {short ? "Avulso" : "Membro Avulso"}
    </span>
  );
}

function Stars({ count, max = 5 }) {
  return (
    <span className="stars" aria-label={`${count} de ${max} estrelas`}>
      {Array.from({ length: max }, (_, i) => (
        <Star key={i} filled={i < count} />
      ))}
    </span>
  );
}

function Avatar({ player, size = 44, shape = "round" }) {
  const style = { width: size, height: size, fontSize: size * 0.38 };
  const shapeClass = shape === "square" ? "avatar-square" : "avatar-round";
  const label = displayName(player);
  if (player.photo) {
    return (
      <img
        src={player.photo}
        alt={label}
        className={`avatar avatar-photo ${shapeClass}`}
        style={{ ...style, objectPosition: player.photoPosition || "50% 50%" }}
      />
    );
  }
  return (
    <div className={`avatar avatar-fallback ${shapeClass}`} style={style}>
      {initials(label)}
    </div>
  );
}

// Linha "cartão" da lista de presença — avatar, nome, subtítulo (posição/
// tag) e um badge de status colorido com chevron, no estilo de app de
// organização de pelada. Usada nas 4 seções (goleiros/confirmados/avulsos/
// ausentes) pra manter tudo visualmente consistente.
function PresenceRowCard({
  player,
  guestName,
  subtitle,
  statusLabel,
  statusTone = "green",
  onClick,
  queueNum,
  onReorderUp,
  onReorderDown,
  reorderUpDisabled,
  reorderDownDisabled,
  adminExtra,
  onRemove,
  byTag,
  autoTag,
}) {
  const name = player ? displayName(player) : guestName;
  const statusIcon = statusTone === "green" ? emo("✓") : statusTone === "yellow" ? emo("🕐") : statusTone === "red" ? emo("✕") : null;
  return (
    <li className="presence-card-row">
      <div className="presence-card-top">
        {(onReorderUp || onReorderDown) && (
          <div className="reorder-btns">
            <button
              type="button"
              className="reorder-btn"
              disabled={reorderUpDisabled}
              onClick={onReorderUp}
              aria-label={`Mover ${name} pra cima`}
            >
              ▲
            </button>
            <button
              type="button"
              className="reorder-btn"
              disabled={reorderDownDisabled}
              onClick={onReorderDown}
              aria-label={`Mover ${name} pra baixo`}
            >
              ▼
            </button>
          </div>
        )}
        {queueNum != null && <span className="presence-card-num">{queueNum}</span>}
        {player ? (
          <Avatar player={player} shape="round" size={40} />
        ) : (
          <div className="avatar avatar-fallback avatar-round presence-card-guest-avatar">
            {initials(name)}
          </div>
        )}
        <div
          className={`presence-card-main ${onClick ? "presence-card-main-clickable" : ""}`}
          onClick={onClick}
        >
          <span className="presence-card-name">
            {name}
            {autoTag && <span className="presence-auto-tag">{autoTag}</span>}
          </span>
          {subtitle && <span className="presence-card-sub">{subtitle}</span>}
        </div>
        <div className="presence-card-right">
          {statusLabel && (
            <span className={`presence-card-status presence-card-status-${statusTone}`}>
              <span className="presence-card-status-icon">{statusIcon}</span>
              {statusLabel}
            </span>
          )}
        </div>
      </div>
      {(byTag || adminExtra || onRemove) && (
        <div className="presence-card-admin-row">
          {byTag && <span className="presence-card-bytag">{byTag}</span>}
          {adminExtra}
          {onRemove && (
            <button className="link link-danger presence-remove" onClick={onRemove}>
              remover
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// Ícone de "pessoas" (usado nos contadores da página da lista de presença)
// — SVG simples com fill="currentColor" pra herdar a cor do texto/tom
// (verde/amarelo/vermelho) sem precisar de 3 emojis diferentes.
function PeopleIcon({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3Zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3Zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5Zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5Z" />
    </svg>
  );
}

// Ícones de calendário / relógio / pin em SVG flat (fill="currentColor") —
// usados no lugar dos emojis 📅🕐📍 pra não depender do estilo colorido e
// desproporcional que cada aparelho desenha pra emoji (iOS em especial).
function CalendarIcon({ className }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}
function ClockIcon({ className }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}
function PinIcon({ className }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}

function TeamShield({ name, size = 24 }) {
  if (!name) return null;
  const color = teamShieldColor(name);
  return (
    <span
      className="team-shield"
      style={{ "--shield-color": color, width: size, height: size * 1.14, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </span>
  );
}

// Escudos reais de clubes conhecidos (buscados na internet). Time do coração
// que não estiver no mapa cai automaticamente no escudo gerado (TeamShield).
const CREST_AMERICA_MG = "/assets/crest-america-mineiro.png";
const CREST_CRUZEIRO = "/assets/crest-cruzeiro.png";
const CREST_CORINTHIANS = "/assets/crest-corinthians.png";
const CREST_ATLETICO_MG = "/assets/crest-atletico-mineiro.png";

const CLUB_CRESTS = {
  "america mineiro": CREST_AMERICA_MG,
  cruzeiro: CREST_CRUZEIRO,
  corinthians: CREST_CORINTHIANS,
  "atletico mineiro": CREST_ATLETICO_MG,
};
const CLUB_ALIASES = {
  timao: "corinthians",
  corinthian: "corinthians",
  raposa: "cruzeiro",
  galo: "atletico mineiro",
  atletico: "atletico mineiro",
  "atletico-mg": "atletico mineiro",
  "atletico mg": "atletico mineiro",
  cam: "atletico mineiro",
  coelho: "america mineiro",
  america: "america mineiro",
  "america-mg": "america mineiro",
  "america mg": "america mineiro",
  americamg: "america mineiro",
};

// As 4 opções fixas do seletor de "time do coração" — a quinta, "Outro", vira
// um campo de texto livre dentro do próprio seletor.
const FAVORITE_TEAM_OPTIONS = ["América", "Atlético Mineiro", "Cruzeiro", "Corinthians"];
function normalizeTeamName(name) {
  return (name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}
function lookupCrestUrl(name) {
  const norm = normalizeTeamName(name);
  if (!norm) return null;
  const key = CLUB_CRESTS[norm] ? norm : CLUB_ALIASES[norm];
  return key ? CLUB_CRESTS[key] : null;
}

// Time do coração: tenta o escudo oficial (buscado na internet); se a imagem
// falhar ao carregar ou o time não estiver mapeado, cai no escudo gerado.
function FavoriteTeamBadge({ name, size = 28 }) {
  const [failed, setFailed] = useState(false);
  const crestUrl = lookupCrestUrl(name);
  if (crestUrl && !failed) {
    return (
      <img
        src={crestUrl}
        alt={name}
        className="fav-team-crest-img"
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return <TeamShield name={name} size={size} />;
}

// Campo de "time do coração": um botão que abre uma folha com as 4 opções
// fixas (cada uma já mostrando o escudo, real ou gerado) + "Outro" com campo
// de texto livre (também com o escudo aparecendo enquanto digita). Usado
// tanto no card editado pelo admin quanto no "Meu card" de cada jogador.
function FavoriteTeamField({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const isCustom = !!value && !FAVORITE_TEAM_OPTIONS.includes(value);
  const [customText, setCustomText] = useState(isCustom ? value : "");
  const [showCustomInput, setShowCustomInput] = useState(isCustom);

  const openSheet = () => {
    setCustomText(isCustom ? value : "");
    setShowCustomInput(isCustom);
    setOpen(true);
  };

  return (
    <>
      <button type="button" className="fav-team-trigger" onClick={openSheet}>
        {value ? (
          <>
            <FavoriteTeamBadge name={value} size={32} />
            <span className="fav-team-trigger-name">{value}</span>
          </>
        ) : (
          <>
            <span className="fav-team-other-icon"><Emo e="⚽" /></span>
            <span className="fav-team-trigger-placeholder">Escolher time do coração</span>
          </>
        )}
        <span className="fav-team-trigger-caret">▾</span>
      </button>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal fav-team-sheet" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">Time do coração</h2>
            <div className="fav-team-options">
              {FAVORITE_TEAM_OPTIONS.map((team) => (
                <button
                  key={team}
                  type="button"
                  className={`fav-team-option ${value === team ? "fav-team-option-active" : ""}`}
                  onClick={() => {
                    onChange(team);
                    setOpen(false);
                  }}
                >
                  <FavoriteTeamBadge name={team} size={36} />
                  <span>{team}</span>
                </button>
              ))}
              <button
                type="button"
                className={`fav-team-option ${showCustomInput ? "fav-team-option-active" : ""}`}
                onClick={() => setShowCustomInput(true)}
              >
                <span className="fav-team-other-icon"><Emo e="⚽" /></span>
                <span>Outro</span>
              </button>
            </div>

            {showCustomInput && (
              <div className="fav-team-custom">
                {customText.trim() ? (
                  <FavoriteTeamBadge name={customText.trim()} size={36} />
                ) : (
                  <span className="fav-team-other-icon"><Emo e="⚽" /></span>
                )}
                <input
                  className="input"
                  autoFocus
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  placeholder="Digite o nome do time"
                />
              </div>
            )}

            <div className="modal-actions">
              {value && (
                <button
                  type="button"
                  className="link link-danger"
                  onClick={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  remover
                </button>
              )}
              <div className="spacer" />
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                Cancelar
              </button>
              {showCustomInput && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!customText.trim()}
                  onClick={() => {
                    onChange(customText.trim());
                    setOpen(false);
                  }}
                >
                  Confirmar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function resizeImage(file, maxDim = 480, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function ReframeModal({ photo, initialPosition, onSave, onCancel }) {
  const [pos, setPos] = useState(initialPosition || { x: 50, y: 50 });
  const boxRef = useRef(null);
  const dragging = useRef(false);

  const updateFromEvent = (e) => {
    const rect = boxRef.current.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
    setPos({ x: Math.round(x), y: Math.round(y) });
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Reenquadrar foto de perfil</h2>
        <p className="admin-hint">Arraste dentro do círculo para escolher a parte da foto que aparece.</p>
        <div
          ref={boxRef}
          className="reframe-box"
          onPointerDown={(e) => {
            dragging.current = true;
            boxRef.current.setPointerCapture(e.pointerId);
            updateFromEvent(e);
          }}
          onPointerMove={(e) => {
            if (dragging.current) updateFromEvent(e);
          }}
          onPointerUp={() => (dragging.current = false)}
        >
          <img
            src={photo}
            alt="Reenquadrar"
            className="reframe-img"
            style={{ objectPosition: `${pos.x}% ${pos.y}%` }}
          />
          <div className="reframe-circle-mask" />
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancelar
          </button>
          <div className="spacer" />
          <button className="btn btn-primary" onClick={() => onSave(`${pos.x}% ${pos.y}%`)}>
            Salvar posição
          </button>
        </div>
      </div>
    </div>
  );
}

function PlayerForm({
  player,
  onSave,
  onCancel,
  onDelete,
  linkableProfiles,
  linkedProfile,
  onLinkUser,
  initialPhone,
}) {
  // id estável: se for edição, usa o id existente; se for jogador novo,
  // gera um id agora mesmo, antes de salvar, pra já poder subir fotos para
  // o Storage (o caminho do arquivo precisa de um id desde o primeiro upload).
  const playerId = useRef(player?.id ?? crypto.randomUUID()).current;

  const [name, setName] = useState(player?.name ?? "");
  const [nickname, setNickname] = useState(player?.nickname ?? "");
  const [rating, setRating] = useState(player?.rating ?? 7);
  const [ratingTxt, setRatingTxt] = useState(String(player?.rating ?? 7).padStart(2, "0"));
  const [isGK, setIsGK] = useState(player?.isGK ?? false);
  const [photo, setPhoto] = useState(player?.photo ?? null);
  const [photoPosition, setPhotoPosition] = useState(player?.photoPosition ?? "50% 50%");
  const [showReframe, setShowReframe] = useState(false);
  const [covers, setCovers] = useState([
    player?.cover1 ?? null,
    player?.cover2 ?? null,
    player?.cover3 ?? null,
    player?.cover4 ?? null,
    player?.cover5 ?? null,
  ]);
  const [coverPositions, setCoverPositions] = useState([
    player?.cover1Position ?? "50% 50%",
    player?.cover2Position ?? "50% 50%",
    player?.cover3Position ?? "50% 50%",
    player?.cover4Position ?? "50% 50%",
    player?.cover5Position ?? "50% 50%",
  ]);
  const [reframeCoverIndex, setReframeCoverIndex] = useState(null);
  const [position, setPosition] = useState(player?.position ?? "");
  const [favoriteTeam, setFavoriteTeam] = useState(player?.favoriteTeam ?? "");
  const [shirt, setShirt] = useState(player?.shirtNumber != null ? String(player.shirtNumber) : "");
  const [instagram, setInstagram] = useState(player?.instagram ?? "");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [membershipType, setMembershipType] = useState(player?.membershipType ?? "avulso");
  const [uploading, setUploading] = useState({});
  const [uploadError, setUploadError] = useState("");
  const fileRef = useRef(null);
  const coverRefs = [useRef(null), useRef(null), useRef(null), useRef(null), useRef(null)];

  // Redimensiona localmente (mesma função de antes) e sobe pro Supabase
  // Storage, devolvendo a URL pública que fica salva no banco.
  const uploadPhoto = async (file, slot, maxDim, quality) => {
    const dataUrl = await resizeImage(file, maxDim, quality);
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${playerId}/${slot}-${Date.now()}.jpg`;
    const { error } = await supabase.storage
      .from("player-photos")
      .upload(path, blob, { contentType: "image/jpeg", upsert: true });
    if (error) throw error;
    const { data } = supabase.storage.from("player-photos").getPublicUrl(path);
    return data.publicUrl;
  };

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError("");
    setUploading((u) => ({ ...u, photo: true }));
    try {
      const url = await uploadPhoto(file, "profile", 340, 0.86);
      setPhoto(url);
      setPhotoPosition("50% 50%");
    } catch {
      setUploadError("Não foi possível enviar a foto. Verifique sua conexão e se está logado como administrador.");
    } finally {
      setUploading((u) => ({ ...u, photo: false }));
    }
  };

  const handleCoverPhoto = (index) => async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const slot = `cover${index + 1}`;
    setUploadError("");
    setUploading((u) => ({ ...u, [slot]: true }));
    try {
      const url = await uploadPhoto(file, slot, 1080, 0.88);
      setCovers((prev) => {
        const next = [...prev];
        next[index] = url;
        return next;
      });
      setCoverPositions((prev) => {
        const next = [...prev];
        next[index] = "50% 50%";
        return next;
      });
    } catch {
      setUploadError("Não foi possível enviar a foto. Verifique sua conexão e se está logado como administrador.");
    } finally {
      setUploading((u) => ({ ...u, [slot]: false }));
    }
  };
  const removeCover = (index) =>
    setCovers((prev) => {
      const next = [...prev];
      next[index] = null;
      return next;
    });

  const canSave = name.trim().length > 0;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{player ? "Editar jogador" : "Novo jogador"}</h2>

        <div className="photo-row">
          <Avatar player={{ name: name || "?", photo, photoPosition }} shape="round" size={72} />
          <div className="photo-actions">
            <button
              className="btn btn-ghost btn-sm"
              disabled={uploading.photo}
              onClick={() => fileRef.current.click()}
            >
              {uploading.photo ? "Enviando…" : photo ? "Trocar foto de perfil" : "Adicionar foto de perfil"}
            </button>
            {photo && !uploading.photo && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowReframe(true)}>
                Reenquadrar
              </button>
            )}
            {photo && !uploading.photo && (
              <button className="btn btn-ghost btn-sm btn-danger-text" onClick={() => setPhoto(null)}>
                Remover
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={handlePhoto}
            />
          </div>
        </div>

        {showReframe && photo && (
          <ReframeModal
            photo={photo}
            initialPosition={(() => {
              const [x, y] = photoPosition.replace(/%/g, "").split(" ").map(Number);
              return { x: x || 50, y: y || 50 };
            })()}
            onCancel={() => setShowReframe(false)}
            onSave={(newPos) => {
              setPhotoPosition(newPos);
              setShowReframe(false);
            }}
          />
        )}

        <label className="field-label">Fotos de capa do card (até 5)</label>
        <div className="cover-slots">
          {covers.map((cover, i) => {
            const slotKey = `cover${i + 1}`;
            const isUploading = uploading[slotKey];
            return (
              <div className="cover-slot" key={i}>
                <button
                  type="button"
                  className="cover-slot-thumb"
                  disabled={isUploading}
                  onClick={() => coverRefs[i].current.click()}
                >
                  {isUploading ? (
                    <span className="cover-slot-uploading">…</span>
                  ) : cover ? (
                    <img src={cover} alt={`Capa ${i + 1}`} style={{ objectPosition: coverPositions[i] }} />
                  ) : (
                    <span className="cover-slot-plus">+</span>
                  )}
                </button>
                {cover && !isUploading && (
                  <button
                    type="button"
                    className="cover-slot-reframe"
                    onClick={() => setReframeCoverIndex(i)}
                    aria-label={`Reenquadrar capa ${i + 1}`}
                    title="Reenquadrar"
                  >
                    ⤢
                  </button>
                )}
                {cover && !isUploading && (
                  <button
                    type="button"
                    className="cover-slot-remove"
                    onClick={() => removeCover(i)}
                    aria-label={`Remover capa ${i + 1}`}
                  >
                    ×
                  </button>
                )}
                <input
                  ref={coverRefs[i]}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={handleCoverPhoto(i)}
                />
              </div>
            );
          })}
        </div>
        <p className="field-hint">
          As fotos de capa alternam no card individual do jogador e no carrossel de destaques
          da home. Toque no ⤢ pra ajustar o enquadramento de cada uma.
        </p>
        {uploadError && <p className="error-text">{uploadError}</p>}

        {reframeCoverIndex !== null && covers[reframeCoverIndex] && (
          <ReframeModal
            photo={covers[reframeCoverIndex]}
            initialPosition={(() => {
              const [x, y] = coverPositions[reframeCoverIndex].replace(/%/g, "").split(" ").map(Number);
              return { x: x || 50, y: y || 50 };
            })()}
            onCancel={() => setReframeCoverIndex(null)}
            onSave={(newPos) => {
              setCoverPositions((prev) => {
                const next = [...prev];
                next[reframeCoverIndex] = newPos;
                return next;
              });
              setReframeCoverIndex(null);
            }}
          />
        )}

        <label className="field-label">Nome completo</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nome do jogador"
          autoFocus
        />

        <label className="field-label">Apelido (opcional)</label>
        <input
          className="input"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="Como ele é chamado na pelada"
        />
        <p className="field-hint">
          Se preenchido, o apelido aparece maior nos cards e o nome completo fica embaixo, menor.
        </p>

        <label className="field-label">
          Nota — <Stars count={starsFilled(rating)} /> ({String(rating).padStart(2, "0")}/99)
        </label>
        <input
          className="input nota-input"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={2}
          value={ratingTxt}
          placeholder="00"
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "").slice(0, 2);
            setRatingTxt(v);
            if (v !== "") setRating(clampRating(Number(v)));
          }}
          onBlur={() => setRatingTxt(String(rating).padStart(2, "0"))}
        />
        <p className="field-hint">Digite dois números, de 00 a 99.</p>

        <label className="switch-row">
          <span><Emo e="🧤" /> Goleiro</span>
          <button
            type="button"
            className={`toggle ${isGK ? "toggle-on" : ""}`}
            onClick={() => setIsGK((v) => !v)}
            aria-pressed={isGK}
          >
            <span className="toggle-knob" />
          </button>
        </label>

        <label className="field-label">Posição preferida (opcional)</label>
        <select className="input" value={position} onChange={(e) => setPosition(e.target.value)}>
          <option value="">Não informar</option>
          {POSITIONS.map((pos) => (
            <option key={pos.code} value={pos.code}>
              {pos.code} ({pos.label})
            </option>
          ))}
        </select>

        <label className="field-label">Camisa (opcional)</label>
        <input
          className="input"
          type="number"
          inputMode="numeric"
          min="0"
          max="99"
          value={shirt}
          onChange={(e) => setShirt(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
          placeholder="Ex.: 10"
        />
        <p className="field-hint">Aparece no canto da sua carta de destaque (0 a 99).</p>

        <label className="field-label">Time do coração (opcional)</label>
        <FavoriteTeamField value={favoriteTeam} onChange={(v) => setFavoriteTeam(v || "")} />

        <label className="field-label">Instagram (opcional)</label>
        <input
          className="input"
          value={instagram}
          onChange={(e) => setInstagram(e.target.value)}
          placeholder="@usuario"
        />
        <p className="field-hint">Aparece no card com o ícone do Instagram, visível pra todo mundo.</p>

        <label className="field-label">Contato telefônico (opcional)</label>
        <input
          className="input"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(00) 00000-0000"
        />
        <p className="field-hint">Só aparece no card pra administradores — o resto não vê.</p>

        <label className="field-label">Tipo de membro</label>
        <select
          className="input"
          value={membershipType}
          onChange={(e) => setMembershipType(e.target.value)}
        >
          <option value="avulso">Avulso</option>
          <option value="mensalista">Mensalista</option>
        </select>
        <p className="field-hint">
          Mensalista aparece no card com selo <Emo e="🏅" /> "Membro Mensalista" e recebe o aviso de
          mensalidade todo dia 1º. Avulso aparece só na aba Avulsos da lista de presença e
          recebe o aviso de pagamento avulso ao confirmar presença.
        </p>

        {player && linkableProfiles && (
          <>
            <label className="field-label">Login vinculado a este card</label>
            <select
              className="input"
              value={linkedProfile?.id || ""}
              onChange={(e) => onLinkUser(player.id, e.target.value || null)}
            >
              <option value="">— nenhum login vinculado —</option>
              {linkedProfile && (
                <option value={linkedProfile.id}>
                  {linkedProfile.fullName || linkedProfile.email} ({linkedProfile.email})
                </option>
              )}
              {linkableProfiles.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.fullName || pr.email} ({pr.email})
                </option>
              ))}
            </select>
            <p className="field-hint">
              Direciona a conta que o jogador criou (e-mail/senha) pra este card. Só quem
              estiver vinculado consegue confirmar presença e editar a própria foto/apelido.
            </p>
          </>
        )}

        <div className="modal-actions">
          {player && (
            <button className="btn btn-danger-text" onClick={() => onDelete(player.id)}>
              Excluir
            </button>
          )}
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            disabled={!canSave || Object.values(uploading).some(Boolean)}
            onClick={() =>
              onSave({
                id: playerId,
                name: formatFullNameValue(name),
                nickname: nickname.trim() ? formatDisplayNameValue(nickname) : null,
                rating: clampRating(rating),
                isGK,
                photo,
                photoPosition,
                cover1: covers[0],
                cover2: covers[1],
                cover3: covers[2],
                cover4: covers[3],
                cover5: covers[4],
                cover1Position: coverPositions[0],
                cover2Position: coverPositions[1],
                cover3Position: coverPositions[2],
                cover4Position: coverPositions[3],
                cover5Position: coverPositions[4],
                position: position || null,
                favoriteTeam: favoriteTeam.trim() || null,
                shirtNumber: shirt === "" ? null : Math.min(99, Number(shirt)),
                shirtNumberClear: shirt === "" && player?.shirtNumber != null,
                instagram: cleanInstagramHandle(instagram) || null,
                phone: phone.trim() || null,
                membershipType,
              })
            }
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

// Edição do PRÓPRIO card para usuário comum: só apelido + fotos (perfil e
// carrossel). Nome completo, nota, posição, goleiro e time do coração só o
// administrador altera — o banco (RLS + gatilho) já barra isso de verdade,
// aqui é só pra nem mostrar o campo.
function MyProfileForm({ player, initialPhone, onSave, onCancel }) {
  const [isGK, setIsGK] = useState(player?.isGK ?? false);
  const [position, setPosition] = useState(player?.position ?? "");
  const [nickname, setNickname] = useState(player?.nickname ?? "");
  const [shirt, setShirt] = useState(player?.shirtNumber != null ? String(player.shirtNumber) : "");
  const [favoriteTeam, setFavoriteTeam] = useState(player?.favoriteTeam ?? "");
  const [instagram, setInstagram] = useState(player?.instagram ?? "");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [photo, setPhoto] = useState(player?.photo ?? null);
  const [photoPosition, setPhotoPosition] = useState(player?.photoPosition ?? "50% 50%");
  const [showReframe, setShowReframe] = useState(false);
  const [covers, setCovers] = useState([
    player?.cover1 ?? null,
    player?.cover2 ?? null,
    player?.cover3 ?? null,
    player?.cover4 ?? null,
    player?.cover5 ?? null,
  ]);
  const [coverPositions, setCoverPositions] = useState([
    player?.cover1Position ?? "50% 50%",
    player?.cover2Position ?? "50% 50%",
    player?.cover3Position ?? "50% 50%",
    player?.cover4Position ?? "50% 50%",
    player?.cover5Position ?? "50% 50%",
  ]);
  const [reframeCoverIndex, setReframeCoverIndex] = useState(null);
  const [uploading, setUploading] = useState({});
  const [uploadError, setUploadError] = useState("");
  const fileRef = useRef(null);
  const coverRefs = [useRef(null), useRef(null), useRef(null), useRef(null), useRef(null)];

  const uploadPhoto = async (file, slot, maxDim, quality) => {
    const dataUrl = await resizeImage(file, maxDim, quality);
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${player.id}/${slot}-${Date.now()}.jpg`;
    const { error } = await supabase.storage
      .from("player-photos")
      .upload(path, blob, { contentType: "image/jpeg", upsert: true });
    if (error) throw error;
    const { data } = supabase.storage.from("player-photos").getPublicUrl(path);
    return data.publicUrl;
  };

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError("");
    setUploading((u) => ({ ...u, photo: true }));
    try {
      const url = await uploadPhoto(file, "profile", 340, 0.86);
      setPhoto(url);
      setPhotoPosition("50% 50%");
    } catch {
      setUploadError("Não foi possível enviar a foto. Verifique sua conexão.");
    } finally {
      setUploading((u) => ({ ...u, photo: false }));
    }
  };

  const handleCoverPhoto = (index) => async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const slot = `cover${index + 1}`;
    setUploadError("");
    setUploading((u) => ({ ...u, [slot]: true }));
    try {
      const url = await uploadPhoto(file, slot, 1080, 0.88);
      setCovers((prev) => {
        const next = [...prev];
        next[index] = url;
        return next;
      });
      setCoverPositions((prev) => {
        const next = [...prev];
        next[index] = "50% 50%";
        return next;
      });
    } catch {
      setUploadError("Não foi possível enviar a foto. Verifique sua conexão.");
    } finally {
      setUploading((u) => ({ ...u, [slot]: false }));
    }
  };
  const removeCover = (index) =>
    setCovers((prev) => {
      const next = [...prev];
      next[index] = null;
      return next;
    });

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Editar meu perfil</h2>
        <p className="admin-hint">
          Você pode trocar sua foto de perfil, as fotos de capa e o nome que aparece nos
          cards. O resto (nome completo e nota) só o administrador altera.
        </p>

        <div className="photo-row">
          <Avatar player={{ name: player.name, photo, photoPosition }} shape="round" size={72} />
          <div className="photo-actions">
            <button
              className="btn btn-ghost btn-sm"
              disabled={uploading.photo}
              onClick={() => fileRef.current.click()}
            >
              {uploading.photo ? "Enviando…" : photo ? "Trocar foto de perfil" : "Adicionar foto de perfil"}
            </button>
            {photo && !uploading.photo && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowReframe(true)}>
                Reenquadrar
              </button>
            )}
            {photo && !uploading.photo && (
              <button className="btn btn-ghost btn-sm btn-danger-text" onClick={() => setPhoto(null)}>
                Remover
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={handlePhoto} />
          </div>
        </div>

        {showReframe && photo && (
          <ReframeModal
            photo={photo}
            initialPosition={(() => {
              const [x, y] = photoPosition.replace(/%/g, "").split(" ").map(Number);
              return { x: x || 50, y: y || 50 };
            })()}
            onCancel={() => setShowReframe(false)}
            onSave={(newPos) => {
              setPhotoPosition(newPos);
              setShowReframe(false);
            }}
          />
        )}

        <label className="field-label">Fotos de capa do card (até 5)</label>
        <div className="cover-slots">
          {covers.map((cover, i) => {
            const slotKey = `cover${i + 1}`;
            const isUploading = uploading[slotKey];
            return (
              <div className="cover-slot" key={i}>
                <button
                  type="button"
                  className="cover-slot-thumb"
                  disabled={isUploading}
                  onClick={() => coverRefs[i].current.click()}
                >
                  {isUploading ? (
                    <span className="cover-slot-uploading">…</span>
                  ) : cover ? (
                    <img src={cover} alt={`Capa ${i + 1}`} style={{ objectPosition: coverPositions[i] }} />
                  ) : (
                    <span className="cover-slot-plus">+</span>
                  )}
                </button>
                {cover && !isUploading && (
                  <button
                    type="button"
                    className="cover-slot-reframe"
                    onClick={() => setReframeCoverIndex(i)}
                    aria-label={`Reenquadrar capa ${i + 1}`}
                    title="Reenquadrar"
                  >
                    ⤢
                  </button>
                )}
                {cover && !isUploading && (
                  <button
                    type="button"
                    className="cover-slot-remove"
                    onClick={() => removeCover(i)}
                    aria-label={`Remover capa ${i + 1}`}
                  >
                    ×
                  </button>
                )}
                <input
                  ref={coverRefs[i]}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={handleCoverPhoto(i)}
                />
              </div>
            );
          })}
        </div>
        <p className="field-hint">Toque no ⤢ pra ajustar o enquadramento de cada capa.</p>
        {uploadError && <p className="error-text">{uploadError}</p>}

        {reframeCoverIndex !== null && covers[reframeCoverIndex] && (
          <ReframeModal
            photo={covers[reframeCoverIndex]}
            initialPosition={(() => {
              const [x, y] = coverPositions[reframeCoverIndex].replace(/%/g, "").split(" ").map(Number);
              return { x: x || 50, y: y || 50 };
            })()}
            onCancel={() => setReframeCoverIndex(null)}
            onSave={(newPos) => {
              setCoverPositions((prev) => {
                const next = [...prev];
                next[reframeCoverIndex] = newPos;
                return next;
              });
              setReframeCoverIndex(null);
            }}
          />
        )}

        <label className="fld">
          <span className="k">NOME</span>
          <input className="v" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Como te chamam" />
        </label>
        <p className="field-hint">Aparece sempre em caixa alta nos cards.</p>

        <label className="fld fld-new">
          <span className="k">CAMISA</span>
          <input
            className="v"
            type="number"
            inputMode="numeric"
            min="0"
            max="99"
            value={shirt}
            onChange={(e) => setShirt(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
            placeholder="Ex.: 10"
          />
        </label>
        <p className="field-hint">Aparece no canto da sua carta de destaque (0 a 99).</p>

        <label className="switch-row">
          <span><Emo e="🧤" /> Goleiro</span>
          <button type="button" className={`toggle ${isGK ? "toggle-on" : ""}`} onClick={() => setIsGK((v) => !v)} aria-pressed={isGK}>
            <span className="toggle-knob" />
          </button>
        </label>

        <label className="field-label">Posição</label>
        <select className="input" value={position} onChange={(e) => setPosition(e.target.value)}>
          <option value="">Não informar</option>
          {POSITIONS.map((pos) => (
            <option key={pos.code} value={pos.code}>
              {pos.code} ({pos.label})
            </option>
          ))}
        </select>

        <label className="field-label">Time do coração (opcional)</label>
        <FavoriteTeamField value={favoriteTeam} onChange={(v) => setFavoriteTeam(v || "")} />

        <label className="fld">
          <span className="k">INSTAGRAM</span>
          <input className="v" value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="@usuario" />
        </label>
        <p className="field-hint">Aparece no seu card com o ícone do Instagram, pra todo mundo ver.</p>

        <label className="fld">
          <span className="k">TELEFONE</span>
          <input className="v" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(00) 00000-0000" />
        </label>
        <p className="field-hint">Só administradores conseguem ver — o resto do elenco não vê.</p>

        <div className="fut-preview">
          <FutCard
            style={{ width: 170, pointerEvents: "none" }}
            p={{
              ...player,
              nickname: nickname.trim() ? formatDisplayNameValue(nickname) : null,
              shirtNumber: shirt === "" ? null : Math.min(99, Number(shirt)),
              isGK,
              position: position || null,
              photo,
              photoPosition,
            }}
            photo={covers[0] ? { url: covers[0], position: coverPositions[0] } : null}
          />
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancelar
          </button>
          <div className="spacer" />
          <button
            className="btn btn-primary mb-save"
            disabled={Object.values(uploading).some(Boolean)}
            onClick={() =>
              onSave({
                nickname: nickname.trim() ? formatDisplayNameValue(nickname) : null,
                favoriteTeam: favoriteTeam.trim() || null,
                shirtNumber: shirt === "" ? null : Math.min(99, Number(shirt)),
                shirtNumberClear: shirt === "" && player?.shirtNumber != null,
                isGK,
                position: position || null,
                instagram: cleanInstagramHandle(instagram) || null,
                phone: phone.trim() || null,
                photo,
                photoPosition,
                cover1: covers[0],
                cover2: covers[1],
                cover3: covers[2],
                cover4: covers[3],
                cover5: covers[4],
                cover1Position: coverPositions[0],
                cover2Position: coverPositions[1],
                cover3Position: coverPositions[2],
                cover4Position: coverPositions[3],
                cover5Position: coverPositions[4],
              })
            }
          >
            <span>SALVAR</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function PlayerHeroPhotos({ player }) {
  const covers = [
    [player.cover1, player.cover1Position],
    [player.cover2, player.cover2Position],
    [player.cover3, player.cover3Position],
    [player.cover4, player.cover4Position],
    [player.cover5, player.cover5Position],
  ]
    .filter(([url]) => Boolean(url))
    .map(([url, position]) => ({ url, position: position || "50% 50%" }));
  const photos =
    covers.length > 0
      ? covers
      : [player.photo].filter(Boolean).map((url) => ({ url, position: player.photoPosition || "50% 50%" }));
  const [showA, setShowA] = useState(true);
  const [imgA, setImgA] = useState(photos[0] || null);
  const [imgB, setImgB] = useState(photos[1] || photos[0] || null);
  const idxRef = useRef(0);

  useEffect(() => {
    setImgA(photos[0] || null);
    setImgB(photos[1] || photos[0] || null);
    idxRef.current = 0;
    setShowA(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.id, player.photo, player.cover1, player.cover2, player.cover3, player.cover4, player.cover5]);

  // Troca pra foto de índice "next" — usado tanto pelo troca automática
  // quanto pelas setas de navegação manual (que só reiniciam o relógio,
  // já que o efeito abaixo depende de "showA").
  const goToPhoto = (next) => {
    if (showA) setImgB(photos[next]);
    else setImgA(photos[next]);
    setShowA((s) => !s);
    idxRef.current = next;
  };

  useEffect(() => {
    if (photos.length < 2) return;
    const t = setTimeout(() => {
      goToPhoto((idxRef.current + 1) % photos.length);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, 3500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showA, photos.length, player.id]);

  if (photos.length === 0) {
    const [c1, c2] = heroGradient(player.name);
    return (
      <div className="profile-hero-fallback" style={{ background: `linear-gradient(150deg, ${c1}, ${c2})` }}>
        {initials(displayName(player))}
      </div>
    );
  }

  const label = displayName(player);
  return (
    <>
      <img
        className={`hero-crossfade-layer ${showA ? "hero-layer-on" : "hero-layer-off"}`}
        src={imgA?.url}
        alt={label}
        style={{ objectPosition: imgA?.position || "50% 50%" }}
      />
      <img
        className={`hero-crossfade-layer ${!showA ? "hero-layer-on" : "hero-layer-off"}`}
        src={imgB?.url}
        alt={label}
        style={{ objectPosition: imgB?.position || "50% 50%" }}
      />
      {photos.length > 1 && (
        <>
          <button
            type="button"
            className="hero-carousel-nav hero-carousel-nav-prev"
            onClick={(e) => {
              e.stopPropagation();
              goToPhoto((idxRef.current - 1 + photos.length) % photos.length);
            }}
            aria-label="Foto anterior"
          >
            ‹
          </button>
          <button
            type="button"
            className="hero-carousel-nav hero-carousel-nav-next"
            onClick={(e) => {
              e.stopPropagation();
              goToPhoto((idxRef.current + 1) % photos.length);
            }}
            aria-label="Próxima foto"
          >
            ›
          </button>
        </>
      )}
    </>
  );
}

function ProfileModal({ player, onClose: onCloseProp, onEdit, isAdmin, canEditOwn, phone }) {
  if (!player) return null;
  const onClose = () => fxClose(onCloseProp);
  const canEdit = isAdmin || canEditOwn;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="profile-hero">
          <PlayerHeroPhotos player={player} />
          <div className="profile-hero-scrim" />

          <div className="profile-hero-icons">
            <button className="hero-icon-btn" onClick={onClose} aria-label="Fechar">
              ‹
            </button>
            {canEdit && (
              <button className="hero-icon-btn" onClick={onEdit} aria-label="Editar">
                <Emo e="✎" />
              </button>
            )}
          </div>

          <div className="profile-hero-name">
            <div className="profile-hero-name-row">
              <Avatar player={player} shape="round" size={96} />
              <div className="profile-hero-name-col">
                <span className="profile-hero-name-text">{displayName(player)}</span>
                {player.nickname && <span className="profile-hero-fullname">{player.name}</span>}
                {player.instagram && (
                  <InstagramLink handle={player.instagram} className="profile-hero-instagram" />
                )}
              </div>
            </div>
            <Stars count={starsFilled(player.rating)} />
          </div>
        </div>

        <div className="profile-panel">
          <MembershipBadge player={player} className="membership-badge-profile" />
          <ProfileAttendance playerId={player.id} />
          <div className="profile-stats profile-stats-2">
            <div className="profile-stats-left">
            <div className="profile-stat">
              <span className="profile-stat-value">{player.position || "—"}</span>
              <span className="profile-stat-label">Posição</span>
            </div>
              {player.favoriteTeam && (
                <div className="profile-fav-team">
                  <FavoriteTeamBadge name={player.favoriteTeam} size={32} />
                  <div className="profile-fav-team-text">
                    <span className="profile-fav-team-label">Time do coração</span>
                    <span className="profile-fav-team-name">{player.favoriteTeam}</span>
                  </div>
                </div>
              )}

            </div>
            <div className="profile-stat profile-stat-nota">
              <div className={`fut nota-card fut-${player.isGK ? "bord" : isMensalista(player) ? "gold" : "silver"}`}>
                <div className="fut-o">
                  <div className="fut-i">
                    <div className="nota-n">{player.rating}</div>
                    <div className="nota-p"><PosTag p={player} /></div>
                    <div className="fut-glass" />
                  </div>
                </div>
              </div>
              <span className="profile-stat-label">Nota</span>
            </div>
          </div>

          {isAdmin && phone && (
            <div className="profile-admin-contact">
              <span className="profile-admin-contact-label"><Emo e="📞" /> Contato (só admin vê)</span>
              <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="profile-admin-contact-value">
                {phone}
              </a>
            </div>
          )}

          {canEdit ? (
            <>
              <button className="btn btn-primary btn-block profile-cta" onClick={onEdit}>
                Editar perfil
              </button>
              <button className="link profile-close-link" onClick={onClose}>
                Fechar
              </button>
            </>
          ) : (
            <button className="btn btn-ghost btn-block profile-cta" onClick={onClose}>
              Fechar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepDots({ step }) {
  const labels = ["Jogadores", "Configuração", "Resultado"];
  return (
    <div className="step-dots">
      {labels.map((l, i) => (
        <div key={l} className={`step-dot ${i + 1 === step ? "step-dot-active" : i + 1 < step ? "step-dot-done" : ""}`}>
          <span className="step-dot-num">{i + 1}</span>
          <span className="step-dot-label">{l}</span>
        </div>
      ))}
    </div>
  );
}

// Sorteia uma das fotos de capa cadastradas do jogador — não é sempre a
// primeira, pra variar qual foto aparece quando ele cai no "Em destaque".
function pickRandomCover(p) {
  const covers = [
    [p.cover1, p.cover1Position],
    [p.cover2, p.cover2Position],
    [p.cover3, p.cover3Position],
    [p.cover4, p.cover4Position],
    [p.cover5, p.cover5Position],
  ].filter(([url]) => Boolean(url));
  if (!covers.length) return null;
  const [url, pos] = covers[Math.floor(Math.random() * covers.length)];
  return { url, position: pos || "50% 50%" };
}

// Ordem aleatória do carrossel da home: cada jogador ganha um número
// sorteado uma vez por carregamento da página — a ordem muda a cada
// recarregada, mas fica estável enquanto a página está aberta (não fica
// embaralhando a cada atualização da tela).
// Gera uma "chave de sorteio" por jogador que vale pelo carregamento da
// página inteiro (Math.random só na primeira vez que o id aparece).
const makePageShuffleKey = () => {
  const keys = new Map();
  return (id) => {
    if (!keys.has(id)) keys.set(id, Math.random());
    return keys.get(id);
  };
};
const featuredShuffleKey = makePageShuffleKey();
const rosterShuffleKey = makePageShuffleKey();
// Lista de jogadores da home: aleatória a cada recarregada, mas quem tem
// foto de perfil E capa vem primeiro; depois quem tem só uma das duas;
// por último quem não tem foto nenhuma.
const hasAnyCover = (p) => !!(p.cover1 || p.cover2 || p.cover3 || p.cover4 || p.cover5);
const rosterPhotoTier = (p) => {
  const photo = !!p.photo;
  const cover = hasAnyCover(p);
  if (photo && cover) return 0;
  if (photo || cover) return 1;
  return 2;
};
const sortRosterForHome = (players) =>
  [...players].sort(
    (a, b) => rosterPhotoTier(a) - rosterPhotoTier(b) || rosterShuffleKey(a.id) - rosterShuffleKey(b.id)
  );

// DESTAQUES no formato do mockup: 3 cartas em escudo (ouro = mensalista, prata = avulso,
// bordô = goleiro), com a foto de capa dentro da carta, nota/posição no topo e nome embaixo.
const FUT_SIL = (
  <svg viewBox="0 0 84 88" fill="currentColor" aria-hidden="true"><circle cx="42" cy="26" r="17" /><path d="M6 88c2-26 16-34 36-34s34 8 36 34z" /></svg>
);
function FutCard({ p, photo, onViewPlayer, style, className = "" }) {
  const tone = p.isGK ? "bord" : isMensalista(p) ? "gold" : "silver";
  const tag = p.isGK ? "GOLEIRO" : isMensalista(p) ? "MENSALISTA" : "AVULSO";
  const label = displayName(p);
  const { medal } = useAttendance(p.id);
  return (
            <div
              style={style}
              className={`fut fut-${tone} ${className}`}
              role="button"
              tabIndex={0}
              onClick={() => onViewPlayer && onViewPlayer(p)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && onViewPlayer) {
                  e.preventDefault();
                  onViewPlayer(p);
                }
              }}
            >
              <div className="fut-o">
                <div className="fut-i">
                  <div className="fut-bg">
                    {photo ? <img src={photo.url} alt="" style={{ objectPosition: photo.position }} /> : FUT_SIL}
                  </div>
                  <div className="fut-tint" />
                  <div className="fut-shade" />
                  <div className={`fut-bar ${p.shirtNumber != null ? "" : "noshirt"}`} />
                  {p.shirtNumber != null && (
                    <div className="fut-cam">
                      <svg viewBox="0 0 100 100" aria-hidden="true">
                        <defs>
                          <linearGradient id={`camg-${tone}`} x1="0" y1="0" x2="0" y2="1">
                            <stop className="cg1" offset="0" />
                            <stop className="cg2" offset="1" />
                          </linearGradient>
                        </defs>
                        <path className="cam-body" fill={`url(#camg-${tone})`} d="M33 6 Q50 20 67 6 L92 20 L82 42 L72 37 L72 94 L28 94 L28 37 L18 42 L8 20 Z" />
                        <path className="cam-fold" d="M28 37 L28 94 M72 37 L72 94" />
                        <path className="cam-cuff" d="M12 27 L22 32 M88 27 L78 32" />
                        <path className="cam-collar" d="M33 6 Q50 28 67 6" />
                        <path className="cam-hem" d="M29 89 H71" />
                      </svg>
                      <span className="cam-n">{p.shirtNumber}</span>
                    </div>
                  )}
                  <div className={`fut-name ${p.shirtNumber != null ? "" : "noshirt"}`}>{label}</div>
                  <div className={`fut-tag ${p.shirtNumber != null ? "" : "noshirt"}`}>{tag}</div>
                  <div className="fut-rate">
                    <b>{p.rating}</b>
                    <i><PosTag p={p} /></i>
                  </div>
                  <div className="fut-av">
                    {p.photo ? (
                      <img src={p.photo} alt={label} style={{ objectPosition: p.photoPosition || "50% 50%" }} />
                    ) : (
                      <span className="fut-av-ini">{initials(label)}</span>
                    )}
                  </div>
                  {medal > 0 && <div className="fut-seal"><AssiduoSeal rank={medal} size={26} /></div>}
                  <div className="fut-glass" />
                  <div className="fut-glass2" />
                </div>
              </div>
            </div>
  );
}
function FeaturedCards({ players, onViewPlayer }) {
  const withCover = players.filter((p) => p.cover1 || p.cover2 || p.cover3 || p.cover4 || p.cover5);
  const listKey = withCover.map((p) => p.id).join(",");
  const byId = React.useMemo(() => new Map(withCover.map((p) => [p.id, p])), [listKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 3 vagas: cada uma troca de carta sozinha, em horário e jogador aleatórios,
  // esmaecendo a carta atual e surgindo a nova (sem recarregar o bloco todo).
  const [slots, setSlots] = useState(() =>
    [...withCover]
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .map((p) => ({ id: p.id, photo: pickRandomCover(p), fading: false }))
  );
  useEffect(() => {
    // a lista de jogadores mudou (carregou/entrou gente): refaz as vagas
    setSlots(
      [...withCover]
        .sort(() => Math.random() - 0.5)
        .slice(0, 3)
        .map((p) => ({ id: p.id, photo: pickRandomCover(p), fading: false }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  useEffect(() => {
    if (withCover.length <= 3) return;
    let alive = true;
    let t1, t2;
    const tick = () => {
      if (!alive) return;
      const cur = slotsRef.current;
      const i = Math.floor(Math.random() * cur.length);
      const shown = new Set(cur.map((x) => x.id));
      const pool = withCover.filter((p) => !shown.has(p.id));
      if (pool.length) {
        setSlots((prev) => prev.map((x, k) => (k === i ? { ...x, fading: true } : x)));
        t1 = setTimeout(() => {
          if (!alive) return;
          const next = pool[Math.floor(Math.random() * pool.length)];
          setSlots((prev) =>
            prev.map((x, k) => (k === i ? { id: next.id, photo: pickRandomCover(next), fading: false } : x))
          );
        }, 900);
      }
      t2 = setTimeout(tick, 2600 + Math.random() * 2600);
    };
    t2 = setTimeout(tick, 2200 + Math.random() * 2000);
    return () => {
      alive = false;
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);
  const cur = slots.filter((x) => byId.has(x.id));
  if (!cur.length) return null;
  return (
    <div className="fcards-wrap">
      <div className="fcards">
        {cur.map((x) => (
          <FutCard
            key={x.id}
            p={byId.get(x.id)}
            photo={x.photo}
            onViewPlayer={onViewPlayer}
            className={`fut-slot ${x.fading ? "fut-fading" : ""}`}
          />
        ))}
      </div>
    </div>
  );
}

function FeaturedCarousel({ players, onViewPlayer }) {
  // Só entra no carrossel quem já tem foto de capa — sem foto, fica de fora
  // (nada de fallback com iniciais nesse destaque). Ordem aleatória a cada
  // recarregada da página (antes era por nota, e o mesmo ficava sempre em 1º).
  const withCover = players.filter((p) => p.cover1 || p.cover2 || p.cover3 || p.cover4 || p.cover5);
  const list = withCover.length
    ? [...withCover].sort((a, b) => featuredShuffleKey(a.id) - featuredShuffleKey(b.id))
    : [];
  // O sorteio da foto acontece uma vez, quando o jogador entra na rotação
  // (não a cada render) — senão a foto ficaria trocando sozinha o tempo todo.
  const makeEntry = (p) => (p ? { player: p, photo: pickRandomCover(p) } : null);

  const [idx, setIdx] = useState(0);
  const [showA, setShowA] = useState(true);
  const [layerA, setLayerA] = useState(() => makeEntry(list[0]));
  const [layerB, setLayerB] = useState(() => makeEntry(list[1] ?? list[0]));

  const listKey = list.map((p) => p.id).join(",");
  useEffect(() => {
    if (!list.length) return;
    setLayerA(makeEntry(list[0]));
    setLayerB(makeEntry(list[1] ?? list[0]));
    setIdx(0);
    setShowA(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);

  useEffect(() => {
    if (list.length < 2) return;
    const timer = setTimeout(() => {
      const next = (idx + 1) % list.length;
      if (showA) setLayerB(makeEntry(list[next]));
      else setLayerA(makeEntry(list[next]));
      setShowA((s) => !s);
      setIdx(next);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, 4000);
    return () => clearTimeout(timer);
  }, [idx, showA, listKey]);

  if (!list.length) return null;

  const renderCard = (entry) => {
    if (!entry) return null;
    const { player: p, photo: coverPhoto } = entry;
    const [c1, c2] = heroGradient(p.name);
    const label = displayName(p);
    return (
      <div
        className="featured-card"
        role="button"
        tabIndex={0}
        onClick={() => onViewPlayer && onViewPlayer(p)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && onViewPlayer) {
            e.preventDefault();
            onViewPlayer(p);
          }
        }}
      >
        {coverPhoto ? (
          <img
            className="featured-card-photo"
            src={coverPhoto.url}
            alt={label}
            style={{ objectPosition: coverPhoto.position }}
          />
        ) : (
          <div className="featured-card-fallback" style={{ background: `linear-gradient(150deg, ${c1}, ${c2})` }}>
            {initials(label)}
          </div>
        )}
        <span className="featured-card-badge">
          <Emo e="⭐" /> Em destaque
          <span className="featured-card-badge-name">{label}</span>
        </span>
      </div>
    );
  };

  return (
    <div className="featured-carousel">
      <div className={`featured-layer ${showA ? "featured-layer-on" : "featured-layer-off"}`}>
        {renderCard(layerA)}
      </div>
      <div className={`featured-layer ${!showA ? "featured-layer-on" : "featured-layer-off"}`}>
        {renderCard(layerB)}
      </div>
    </div>
  );
}

// Texto curto tipo "agora", "5min", "2h" — usado no cabeçalho do story.
function storyTimeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  return `${h}h`;
}

// Fileira de bolinhas no topo da Home, estilo Instagram/WhatsApp Status —
// a sua sempre primeiro (com botão de + pra postar), depois quem mais tem
// story ativo (últimas 24h), anel dourado enquanto tiver algo não visto.
function StoriesRow({ storiesByPlayer, orderedPlayerIds, players, myPlayer, seenStoryIds, onOpenViewer, onAddClick, uploading }) {
  const getPlayer = (id) => players.find((p) => p.id === id);
  const hasUnseen = (list) => list.some((s) => !seenStoryIds.has(s.id));
  const otherIds = orderedPlayerIds.filter((id) => id !== myPlayer?.id);
  const myStories = myPlayer ? storiesByPlayer[myPlayer.id] || [] : [];

  if (!myPlayer && otherIds.length === 0) return null;

  return (
    <div className="stories-row">
      {myPlayer && (
        <div className="story-circle-wrap">
          <button
            type="button"
            className="story-circle-btn"
            onClick={() => (myStories.length > 0 ? onOpenViewer(myPlayer.id) : onAddClick())}
          >
            <span
              className={`story-ring ${
                myStories.length === 0
                  ? "story-ring-empty"
                  : hasUnseen(myStories)
                  ? "story-ring-unseen"
                  : "story-ring-seen"
              }`}
            >
              <Avatar player={myPlayer} shape="round" size={58} />
            </span>
            <span className="story-circle-label">Seu story</span>
          </button>
          <button
            type="button"
            className="story-add-badge"
            onClick={onAddClick}
            disabled={uploading}
            aria-label="Adicionar story"
          >
            {uploading ? "…" : "+"}
          </button>
        </div>
      )}
      {otherIds.map((id) => {
        const p = getPlayer(id);
        if (!p) return null;
        const list = storiesByPlayer[id];
        return (
          <button
            key={id}
            type="button"
            className="story-circle-btn"
            onClick={() => onOpenViewer(id)}
          >
            <span className={`story-ring ${hasUnseen(list) ? "story-ring-unseen" : "story-ring-seen"}`}>
              <Avatar player={p} shape="round" size={58} />
            </span>
            <span className="story-circle-label">{displayName(p)}</span>
          </button>
        );
      })}
    </div>
  );
}

// Câmera de vídeo dentro do próprio app (getUserMedia + MediaRecorder). Usada
// em vez de abrir a câmera nativa do celular pra gravar vídeo porque, no
// Android, o "atalho" de gravar vídeo através de um formulário do navegador
// aciona um modo de captura simplificado do próprio sistema com qualidade
// bem inferior à do app de Câmera de verdade. Gravando aqui dentro (o
// navegador lê a câmera diretamente), a qualidade fica normal.
const STORY_VIDEO_MAX_SECONDS = 60;

function formatStoryTimer(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function StoryCameraModal({ onClose, onCapture }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const [status, setStatus] = useState("starting"); // starting | live | recording | preview | error
  const [seconds, setSeconds] = useState(0);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setStatus("live");
      } catch {
        if (!cancelled) {
          setErrorMsg("Não foi possível acessar a câmera. Verifique a permissão do navegador pro site.");
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const pickMimeType = () => {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    for (const c of candidates) {
      if (window.MediaRecorder?.isTypeSupported?.(c)) return c;
    }
    return "";
  };

  const stopRecording = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  };

  const startRecording = () => {
    if (!streamRef.current) return;
    const mimeType = pickMimeType();
    const recorder = mimeType
      ? new MediaRecorder(streamRef.current, { mimeType })
      : new MediaRecorder(streamRef.current);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "video/webm" });
      setRecordedBlob(blob);
      setPreviewUrl(URL.createObjectURL(blob));
      setStatus("preview");
    };
    recorder.start();
    recorderRef.current = recorder;
    setSeconds(0);
    setStatus("recording");
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        const next = s + 1;
        if (next >= STORY_VIDEO_MAX_SECONDS) stopRecording();
        return next;
      });
    }, 1000);
  };

  const retake = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setRecordedBlob(null);
    setSeconds(0);
    setStatus("live");
  };

  const handleClose = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    onClose();
  };

  const confirmUse = () => {
    if (recordedBlob) onCapture(recordedBlob);
  };

  return (
    <div className="modal-backdrop story-camera-backdrop">
      <div className="story-camera-modal">
        {status === "error" ? (
          <div className="story-camera-error">
            <p>{errorMsg}</p>
            <button type="button" className="btn btn-ghost" onClick={handleClose}>
              Fechar
            </button>
          </div>
        ) : (
          <>
            {status !== "preview" && (
              <video ref={videoRef} className="story-camera-preview" autoPlay playsInline muted />
            )}
            {status === "preview" && previewUrl && (
              <video src={previewUrl} className="story-camera-preview" autoPlay playsInline loop controls />
            )}
            {(status === "live" || status === "recording") && (
              <div className={`story-camera-timer ${status === "recording" ? "is-recording" : ""}`}>
                {formatStoryTimer(seconds)}
              </div>
            )}
            <button type="button" className="story-camera-close" onClick={handleClose} aria-label="Fechar">
              <Emo e="✕" />
            </button>
            <div className="story-camera-controls">
              {status === "live" && (
                <button
                  type="button"
                  className="story-camera-record-btn"
                  onClick={startRecording}
                  aria-label="Gravar"
                />
              )}
              {status === "recording" && (
                <button
                  type="button"
                  className="story-camera-record-btn is-recording"
                  onClick={stopRecording}
                  aria-label="Parar"
                />
              )}
              {status === "preview" && (
                <>
                  <button type="button" className="btn btn-ghost" onClick={retake}>
                    Regravar
                  </button>
                  <button type="button" className="btn btn-primary" onClick={confirmUse}>
                    Usar vídeo
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Visualizador de story em tela cheia — barrinhas de progresso segmentadas
// no topo (uma por foto/vídeo da pessoa), avança sozinho (5s pra foto, ao
// terminar o vídeo), toca nos lados pra voltar/avançar, e ao acabar o
// último story de alguém já passa pro próximo da fila.
const STORY_REACTIONS = ["❤️", "😂", "🔥", "👏", "😮", "😢"];

function StoryViewerModal({
  orderedPlayerIds,
  storiesByPlayer,
  players,
  startPlayerId,
  isAdmin,
  myPlayerId,
  onClose,
  onSeen,
  onDelete,
  authUser,
  onRecordView,
  onToggleLike,
  onReact,
  onFetchMyInteraction,
  onFetchViewers,
}) {
  const startGroupIdx = Math.max(0, orderedPlayerIds.indexOf(startPlayerId));
  const [groupIdx, setGroupIdx] = useState(startGroupIdx);
  const [itemIdx, setItemIdx] = useState(0);
  const [liked, setLiked] = useState(false);
  const [myReaction, setMyReaction] = useState(null);
  const [reactionSentFlash, setReactionSentFlash] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  const [viewers, setViewers] = useState(null);
  const [viewersLoading, setViewersLoading] = useState(false);

  const currentPlayerId = orderedPlayerIds[groupIdx];
  const player = players.find((p) => p.id === currentPlayerId);
  const list = storiesByPlayer[currentPlayerId] || [];
  const currentItem = list[itemIdx];

  const goNextPlayer = () => {
    const next = groupIdx + 1;
    if (next >= orderedPlayerIds.length) {
      onClose();
      return;
    }
    setGroupIdx(next);
    setItemIdx(0);
  };
  const goPrevPlayer = () => {
    const prev = groupIdx - 1;
    if (prev < 0) {
      onClose();
      return;
    }
    setGroupIdx(prev);
    setItemIdx(0);
  };
  const goNextItem = () => {
    if (itemIdx < list.length - 1) setItemIdx((i) => i + 1);
    else goNextPlayer();
  };
  const goPrevItem = () => {
    if (itemIdx > 0) setItemIdx((i) => i - 1);
    else goPrevPlayer();
  };

  // Se a lista atual ficar vazia (ex.: o dono apagou o único story
  // enquanto alguém via), pula pra próxima pessoa em vez de travar numa
  // tela vazia.
  useEffect(() => {
    if (list.length === 0) goNextPlayer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length, groupIdx]);

  useEffect(() => {
    if (!currentItem) return;
    onSeen(currentItem.id);
    setLiked(false);
    setMyReaction(null);
    setShowViewers(false);
    setViewers(null);
    if (authUser) {
      onRecordView(currentItem.id);
      onFetchMyInteraction(currentItem.id).then((row) => {
        if (!row) return;
        setLiked(!!row.liked_at);
        setMyReaction(row.reaction || null);
      });
    }
    if (currentItem.media_type === "video") return;
    const t = setTimeout(goNextItem, 5000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentItem?.id]);

  useEffect(() => {
    const onEsc = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  if (!player || !currentItem) return null;
  const canDelete = isAdmin || currentPlayerId === myPlayerId;
  const canSeeViewers = canDelete;

  const handleToggleLike = () => {
    if (!authUser) return;
    const next = !liked;
    setLiked(next);
    onToggleLike(currentItem.id, next);
  };

  const handleReact = (emoji) => {
    if (!authUser) return;
    const next = myReaction === emoji ? null : emoji;
    setMyReaction(next);
    onReact(currentItem.id, next || "");
    setReactionSentFlash(true);
    setTimeout(() => setReactionSentFlash(false), 900);
  };

  const openViewers = async () => {
    setShowViewers(true);
    setViewersLoading(true);
    const rows = await onFetchViewers(currentItem.id);
    setViewers(rows);
    setViewersLoading(false);
  };

  return (
    <div className="story-viewer-backdrop" onClick={onClose}>
      <div className="story-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="story-progress-row">
          {list.map((s, i) => (
            <span key={s.id} className="story-progress-track">
              <span
                key={i === itemIdx ? `active-${s.id}` : `idle-${s.id}`}
                className="story-progress-fill"
                style={
                  i < itemIdx
                    ? { width: "100%", animation: "none" }
                    : i > itemIdx
                    ? { width: "0%", animation: "none" }
                    : currentItem.media_type === "image"
                    ? { animation: "storyProgressFill 5s linear forwards" }
                    : { width: "0%", animation: "none" }
                }
              />
            </span>
          ))}
        </div>
        <div className="story-viewer-head">
          <Avatar player={player} shape="round" size={32} />
          <span className="story-viewer-name">{displayName(player)}</span>
          <span className="story-viewer-time">{storyTimeAgo(currentItem.created_at)}</span>
          <div className="spacer" />
          {canDelete && (
            <button
              type="button"
              className="story-viewer-icon-btn"
              onClick={() => onDelete(currentItem.id)}
              aria-label="Excluir story"
            >
              <Emo e="🗑️" />
            </button>
          )}
          <button type="button" className="story-viewer-icon-btn" onClick={onClose} aria-label="Fechar">
            <Emo e="✕" />
          </button>
        </div>
        <div className="story-viewer-media">
          {currentItem.media_type === "video" ? (
            <video
              key={currentItem.id}
              src={currentItem.media_url}
              className="story-media-el"
              autoPlay
              playsInline
              controls={false}
              onEnded={goNextItem}
            />
          ) : (
            <img src={currentItem.media_url} className="story-media-el" alt="" />
          )}
        </div>
        <button type="button" className="story-nav-zone story-nav-prev" onClick={goPrevItem} aria-label="Anterior" />
        <button type="button" className="story-nav-zone story-nav-next" onClick={goNextItem} aria-label="Próximo" />

        {reactionSentFlash && <div className="story-reaction-flash">{myReaction} enviado!</div>}

        <div className="story-bottom-bar">
          {canSeeViewers ? (
            <button type="button" className="story-viewers-pill" onClick={openViewers}>
              <Emo e="👁" /> Ver interações
            </button>
          ) : (
            <span />
          )}
          {authUser && (
            <div className="story-reactions-bar">
              {STORY_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className={`story-reaction-btn ${myReaction === emoji ? "story-reaction-btn-active" : ""}`}
                  onClick={() => handleReact(emoji)}
                  aria-label={`Reagir com ${emoji}`}
                >
                  {emo(emoji)}
                </button>
              ))}
              <button
                type="button"
                className={`story-like-btn ${liked ? "story-like-btn-active" : ""}`}
                onClick={handleToggleLike}
                aria-label="Curtir"
              >
                {liked ? emo("❤️") : emo("🤍")}
              </button>
            </div>
          )}
        </div>

        {showViewers && (
          <div className="story-viewers-panel" onClick={(e) => e.stopPropagation()}>
            <div className="story-viewers-panel-head">
              <span className="story-viewers-panel-title">
                <Emo e="👁" /> {viewers ? viewers.length : "…"} visualizaç{viewers && viewers.length === 1 ? "ão" : "ões"}
              </span>
              <button
                type="button"
                className="story-viewer-icon-btn"
                onClick={() => setShowViewers(false)}
                aria-label="Fechar lista"
              >
                <Emo e="✕" />
              </button>
            </div>
            <div className="story-viewers-panel-list">
              {viewersLoading && <p className="empty-hint">Carregando…</p>}
              {!viewersLoading && viewers && viewers.length === 0 && (
                <p className="empty-hint">Ninguém viu ainda.</p>
              )}
              {!viewersLoading &&
                viewers &&
                viewers.map((v) => {
                  const p = players.find((pl) => pl.id === v.player_id);
                  if (!p) return null;
                  return (
                    <div key={v.id} className="story-viewer-row">
                      <Avatar player={p} shape="round" size={34} />
                      <span className="story-viewer-row-name">{displayName(p)}</span>
                      <span className="story-viewer-row-icons">
                        {v.liked_at && <span title="Curtiu"><Emo e="❤️" /></span>}
                        {v.reaction && <span title="Reagiu">{emo(v.reaction)}</span>}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Login individual: cobre entrar, criar conta, e — pra quem já está logado —
// o próprio painel (admin vê status de admin; usuário comum vê o próprio
// card + presença na próxima pelada, ou um aviso se ainda não foi vinculado).
function AccountModal({
  authUser,
  isAdmin,
  myPlayer,
  onSignIn,
  onSignUp,
  onSignOut,
  onResetPassword,
  onClose,
  onEditMyProfile,
  pelada,
  amIConfirmed,
  amIAbsent,
  onSetMyPresenceStatus,
  onExpressInterest,
  accessBlocked,
  onShowPaymentAlert,
  onSendSuggestion,
  onSignedUp,
}) {
  const [mode, setMode] = useState("signin"); // signin | signup | reset
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestionText, setSuggestionText] = useState("");
  const [suggestionSent, setSuggestionSent] = useState(false);
  const [sendingSuggestion, setSendingSuggestion] = useState(false);

  if (authUser) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2 className="modal-title">Minha conta</h2>
          <p className="admin-hint">{authUser.email}</p>

          {isAdmin && (
            <p className="admin-status"><Emo e="🔓" /> Você está logado como administrador.</p>
          )}

          {!isAdmin && myPlayer && (
            <>
              <div className="account-card-preview">
                <Avatar player={myPlayer} shape="round" size={56} />
                <div>
                  <div className="roster-name">{displayName(myPlayer)}</div>
                  <div className="roster-fullname">{myPlayer.name}</div>
                  <MembershipBadge player={myPlayer} className="membership-badge-inline" />
                </div>
              </div>
              <button className="btn btn-ghost btn-block" onClick={onEditMyProfile}>
                Editar minha foto / apelido
              </button>
              {pelada && accessBlocked && (
                <div className="access-blocked-box">
                  <p className="access-blocked-text">
                    <Emo e="🔒" /> Mensalidade de {monthKeyLabel(currentMonthKey())} pendente — o acesso à
                    lista fica liberado assim que um administrador confirmar o pagamento.
                  </p>
                  <button className="btn btn-primary btn-block" onClick={onShowPaymentAlert}>
                    Ver dados do PIX
                  </button>
                </div>
              )}
              {!isMensalista(myPlayer) && (
                <div className="membership-interest-box">
                  {myPlayer.membershipInterestAt ? (
                    <p className="field-hint">
                      <Emo e="✅" /> Pedido enviado em{" "}
                      {new Date(myPlayer.membershipInterestAt).toLocaleDateString("pt-BR")} —
                      aguardando aprovação de um administrador.
                    </p>
                  ) : (
                    <button className="btn btn-ghost btn-block" onClick={onExpressInterest}>
                      <Emo e="🏅" /> Tenho interesse em ser mensalista
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {!isAdmin && !myPlayer && (
            <p className="admin-hint">
              Sua conta ainda não foi vinculada a um card. Avise um administrador pra ele
              direcionar seu login pro seu jogador — depois disso você já consegue
              confirmar presença e editar sua foto por aqui.
            </p>
          )}

          {onSendSuggestion && (
            <div className="suggestion-form">
              <label className="field-label"><Emo e="💡" /> Sugerir melhoria (pro sistema ou pra pelada)</label>
              {suggestionSent ? (
                <p className="field-hint">Sugestão enviada! Obrigado <Emo e="🙌" /></p>
              ) : (
                <>
                  <textarea
                    value={suggestionText}
                    onChange={(e) => setSuggestionText(e.target.value)}
                    placeholder="Conta pra gente sua ideia ou o que podia melhorar..."
                  />
                  <button
                    className="btn btn-ghost btn-block"
                    disabled={!suggestionText.trim() || sendingSuggestion}
                    onClick={async () => {
                      setSendingSuggestion(true);
                      const ok = await onSendSuggestion(suggestionText);
                      setSendingSuggestion(false);
                      if (ok) {
                        setSuggestionText("");
                        setSuggestionSent(true);
                        setTimeout(() => setSuggestionSent(false), 4000);
                      }
                    }}
                  >
                    {sendingSuggestion ? "Enviando…" : "Enviar sugestão"}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="modal-actions">
            <button className="btn btn-ghost btn-block" onClick={onClose}>
              Fechar
            </button>
            <button className="btn btn-primary btn-block" onClick={onSignOut}>
              Sair
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="account-tabs">
          <button
            className={`account-tab ${mode === "signin" ? "account-tab-active" : ""}`}
            onClick={() => {
              setMode("signin");
              setError("");
              setInfo("");
            }}
          >
            Entrar
          </button>
          <button
            className={`account-tab ${mode === "signup" ? "account-tab-active" : ""}`}
            onClick={() => {
              setMode("signup");
              setError("");
              setInfo("");
            }}
          >
            Criar conta
          </button>
        </div>

        {mode === "signin" && (
          <>
            <h2 className="modal-title">Entrar</h2>
            <p className="admin-hint">
              Use o e-mail e senha da sua conta (administrador ou jogador cadastrado).
            </p>
          </>
        )}
        {mode === "signup" && (
          <>
            <h2 className="modal-title">Criar conta</h2>
            <p className="admin-hint">
              Essa conta é só pra quem já faz parte da Pelada 4K. Se for o seu caso, depois
              de criar a conta avise um administrador pra ele vincular seu login ao seu
              card na lista de jogadores — sem isso você consegue ver a lista, mas não
              confirmar presença nem editar seu perfil.
            </p>
            <label className="field-label">Nome completo</label>
            <input
              className="input"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Seu nome"
            />
          </>
        )}
        {mode === "reset" && (
          <>
            <h2 className="modal-title">Esqueci minha senha</h2>
            <p className="admin-hint">
              Informe o e-mail da sua conta — enviamos um link pra você escolher uma senha
              nova.
            </p>
          </>
        )}

        <label className="field-label">E-mail</label>
        <input
          className="input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />

        {mode !== "reset" && (
          <>
            <label className="field-label">Senha</label>
            <input
              className="input"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}

        {mode === "signin" && (
          <button
            type="button"
            className="link account-forgot-link"
            onClick={() => {
              setMode("reset");
              setError("");
              setInfo("");
            }}
          >
            Esqueci minha senha
          </button>
        )}

        {error && <p className="error-text">{error}</p>}
        {info && <p className="field-hint">{info}</p>}
        <div className="modal-actions">
          {mode === "reset" ? (
            <button
              className="link"
              onClick={() => {
                setMode("signin");
                setError("");
                setInfo("");
              }}
            >
              ← Voltar
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={onClose}>
              Cancelar
            </button>
          )}
          <div className="spacer" />
          {mode === "signin" && (
            <button
              className="btn btn-primary"
              disabled={!email || !password || loading}
              onClick={async () => {
                if (loading) return;
                setLoading(true);
                setError("");
                setInfo("");
                const res = await onSignIn(email, password);
                setLoading(false);
                if (!res.ok) setError(translateAuthError(res.message));
              }}
            >
              {loading ? "Entrando…" : "Entrar"}
            </button>
          )}
          {mode === "signup" && (
            <button
              className="btn btn-primary"
              disabled={!email || !password || password.length < 6 || loading}
              onClick={async () => {
                if (loading) return;
                setLoading(true);
                setError("");
                setInfo("");
                const res = await onSignUp(email, password, fullName.trim());
                setLoading(false);
                if (!res.ok) {
                  setError(translateAuthError(res.message) || "Não foi possível criar a conta.");
                } else {
                  onClose();
                  onSignedUp();
                }
              }}
            >
              {loading ? "Criando…" : "Criar conta"}
            </button>
          )}
          {mode === "reset" && (
            <button
              className="btn btn-primary"
              disabled={!email || loading}
              onClick={async () => {
                if (loading) return;
                setLoading(true);
                setError("");
                setInfo("");
                const res = await onResetPassword(email);
                setLoading(false);
                if (!res.ok) {
                  setError(translateAuthError(res.message) || "Não foi possível enviar o e-mail.");
                } else {
                  setInfo("E-mail enviado! Confira sua caixa de entrada (e o spam) e clique no link.");
                }
              }}
            >
              {loading ? "Enviando…" : "Enviar link"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Depois de clicar no link do e-mail de recuperação, o Supabase volta pro
// app já autenticado numa "sessão de recuperação" — esse modal aparece
// sozinho (ver o listener de PASSWORD_RECOVERY) pra escolher a senha nova.
function SetNewPasswordModal({ onSave, onClose }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Escolher nova senha</h2>
        <p className="admin-hint">Defina a nova senha da sua conta.</p>
        <label className="field-label">Nova senha</label>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <label className="field-label">Confirmar nova senha</label>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <div className="spacer" />
          <button
            className="btn btn-primary"
            disabled={!password || password.length < 6 || loading}
            onClick={async () => {
              if (password !== confirm) {
                setError("As senhas não são iguais.");
                return;
              }
              setLoading(true);
              setError("");
              const res = await onSave(password);
              setLoading(false);
              if (!res.ok) setError(translateAuthError(res.message) || "Não foi possível salvar a senha.");
            }}
          >
            {loading ? "Salvando…" : "Salvar nova senha"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin: adicionar manualmente alguém do elenco que avisou "por fora" que
// vai jogar (sem precisar de login vinculado pra entrar na lista). Busca por
// nome (igual a busca de membros da home) em vez de rolar uma lista enorme.
function PresenceAdminAdd({ players, presentIds, onAdd, placeholder = "Buscar jogador pra incluir na lista…" }) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const available = players.filter((p) => !presentIds.has(p.id));
  if (available.length === 0) return null;
  const q = query.trim().toLowerCase();
  const matches = (
    q
      ? available.filter((p) => displayName(p).toLowerCase().includes(q))
      : available
  ).slice(0, 8);
  return (
    <div className="member-search presence-add-search">
      <div className="member-search-box">
        <span className="member-search-icon"><Emo e="🔍" /></span>
        <input
          className="member-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={placeholder}
        />
        {query && (
          <button
            type="button"
            className="member-search-clear"
            onClick={() => setQuery("")}
            aria-label="Limpar"
          >
            <Emo e="✕" />
          </button>
        )}
      </div>
      {focused && (
        <div className="member-search-suggestions">
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              className="member-search-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onAdd(p.id);
                setQuery("");
              }}
            >
              <Avatar player={p} shape="round" size={30} />
              <span className="member-search-item-text">
                <span className="member-search-item-name">{displayName(p)}</span>
              </span>
            </button>
          ))}
          {matches.length === 0 && <p className="member-search-empty">Ninguém encontrado.</p>}
        </div>
      )}
    </div>
  );
}

// Admin: inclui um AVULSO — alguém de fora do elenco cadastrado, só pra
// essa pelada específica (sem precisar de card nem login).
function PresenceAdminAddGuest({ onAdd }) {
  const [name, setName] = useState("");
  return (
    <div className="presence-add-row">
      <input
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nome do avulso"
      />
      <button
        className="btn btn-ghost btn-sm"
        disabled={!name.trim()}
        onClick={() => {
          onAdd(name);
          setName("");
        }}
      >
        Incluir
      </button>
    </div>
  );
}

function PublishPeladaModal({ onPublish, onClose, title = "Publicar nova pelada", hint }) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [location, setLocation] = useState("");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>
        <p className="admin-hint">
          {hint ||
            "Abre uma nova lista de presença pros jogadores confirmarem. Se já havia uma aberta, ela é encerrada automaticamente."}
        </p>
        <label className="field-label">Data (opcional)</label>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <label className="field-label">Horário (opcional)</label>
        <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <label className="field-label">Local (opcional)</label>
        <input
          className="input"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Ex: Quadra do bairro"
        />
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <div className="spacer" />
          <button
            className="btn btn-primary"
            onClick={() => {
              const scheduledFor = date ? `${date}T${time || "00:00"}:00` : null;
              onPublish({ scheduledFor, location: location.trim() || null });
            }}
          >
            Publicar
          </button>
        </div>
      </div>
    </div>
  );
}

// Popup de aviso do admin — aparece sozinho quando um aviso é publicado
// (na hora, pra quem já está com o app aberto) ou ao carregar a página,
// conforme o modo escolhido pelo admin ("once" some pra sempre depois de
// fechar; "until_date" mostra a data limite e volta a aparecer em cada
// nova visita até aquele prazo).
function AnnouncementPopup({ announcement, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal announcement-modal" onClick={(e) => e.stopPropagation()}>
        <div className="announcement-icon"><Emo e="📢" /></div>
        {announcement.title && <h2 className="modal-title announcement-title">{announcement.title}</h2>}
        <p className="announcement-message">{announcement.message}</p>
        {announcement.mode === "until_date" && announcement.expiresAt && (
          <p className="announcement-expiry">
            Válido até {new Date(announcement.expiresAt).toLocaleString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}
        <button className="btn btn-primary btn-block" onClick={onClose}>
          Entendi
        </button>
      </div>
    </div>
  );
}

// Admin: cria/publica o aviso — escolhe se aparece só uma vez (a pessoa
// fecha e nunca mais vê) ou até um prazo (reaparece em cada visita até a
// data escolhida). Publicar um novo aviso substitui o anterior.
function AdminAnnouncementModal({ current, onPublish, onClear, onClose }) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState("once");
  const [expiresAt, setExpiresAt] = useState("");
  const canPublish = message.trim().length > 0 && (mode === "once" || expiresAt);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="📢" /> Publicar aviso</h2>

        {current && (
          <div className="announcement-current">
            <p className="admin-hint">Aviso ativo agora:</p>
            {current.title && <p className="announcement-current-title">{current.title}</p>}
            <p className="announcement-current-message">{current.message}</p>
            <p className="field-hint">
              {current.mode === "once"
                ? "Aparece uma vez só pra cada pessoa."
                : `Aparece até ${
                    current.expiresAt
                      ? new Date(current.expiresAt).toLocaleString("pt-BR", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—"
                  }.`}
            </p>
            <button className="link link-danger" onClick={onClear}>
              remover aviso atual
            </button>
          </div>
        )}

        <label className="field-label">Título (opcional)</label>
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ex: Atenção, mensalistas!"
        />

        <label className="field-label">Mensagem</label>
        <textarea
          className="input"
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Escreva o aviso que vai aparecer em popup pra todo mundo…"
        />

        <label className="field-label">Quando deve parar de aparecer?</label>
        <div className="announcement-mode-row">
          <label className="switch-row announcement-mode-option">
            <input
              type="radio"
              name="announcement-mode"
              checked={mode === "once"}
              onChange={() => setMode("once")}
            />
            <span>Só uma vez (a pessoa fecha e não vê de novo)</span>
          </label>
          <label className="switch-row announcement-mode-option">
            <input
              type="radio"
              name="announcement-mode"
              checked={mode === "until_date"}
              onChange={() => setMode("until_date")}
            />
            <span>Até um prazo específico (reaparece a cada visita até lá)</span>
          </label>
        </div>
        {mode === "until_date" && (
          <input
            className="input"
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <div className="spacer" />
          <button
            className="btn btn-primary"
            disabled={!canPublish}
            onClick={() =>
              onPublish({
                title,
                message,
                mode,
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
              })
            }
          >
            Publicar aviso
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin: histórico de listas de presença já encerradas (peladas com
// status "closed"). Cada item expande (<details>) mostrando confirmados
// (com goleiros em destaque), avulsos e ausentes daquela pelada.
// Pop-up de cobrança — avulso vê ao confirmar presença, mensalista vê todo
// dia 1º. Mesmo texto/visual pros dois, só troca valor e frase.
function PaymentAlertModal({ kind, pix = PIX_INFO, onAlreadyPaid, onClose }) {
  const msg = PAYMENT_MESSAGES[kind] || PAYMENT_MESSAGES.avulso;
  const [copied, setCopied] = useState(false);
  const copyPixKey = async () => {
    try {
      await navigator.clipboard.writeText(pix.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard indisponível — o usuário copia manualmente */
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal payment-alert-modal payment-alert-orange" onClick={(e) => e.stopPropagation()}>
        <div className="payment-alert-icon"><Emo e="💰" /></div>
        <h2 className="modal-title payment-alert-title">{msg.title}</h2>
        <p className="payment-alert-body">{msg.body}</p>
        {msg.note && <p className="payment-alert-body payment-alert-note">{msg.note}</p>}
        <div className="payment-alert-card">
          <div className="payment-alert-row">
            <span className="payment-alert-label">PIX</span>
            <span className="payment-alert-value">{pix.name}</span>
          </div>
          <div className="payment-alert-row">
            <span className="payment-alert-label">Chave</span>
            <span className="payment-alert-value">{pix.key}</span>
          </div>
          <div className="payment-alert-row payment-alert-amount-row">
            <span className="payment-alert-label">Valor</span>
            <span className="payment-alert-amount">{msg.amount}</span>
          </div>
          <button className="btn btn-ghost btn-sm payment-alert-copy" onClick={copyPixKey}>
            {copied ? emo("✔ Chave copiada!") : "Copiar chave PIX"}
          </button>
        </div>
        <p className="payment-alert-footer">
          Envie o comprovante para algum administrador!<br />Boa pelada! <Emo e="⚽" />
        </p>
        {onAlreadyPaid ? (
          <div className="payment-alert-actions">
            <button className="btn btn-primary btn-block" onClick={onAlreadyPaid}>
              <Emo e="✅" /> JÁ PAGUEI
            </button>
            <button className="btn btn-ghost btn-block" onClick={onClose}>
              Fechar
            </button>
          </div>
        ) : (
          <button className="btn btn-primary btn-block" onClick={onClose}>
            Entendi
          </button>
        )}
      </div>
    </div>
  );
}

// Pop-up que o avulso vê ao colocar o nome na lista (entra na fila de
// espera) — avisa que ele só entra na lista oficial (e só paga) se algum
// mensalista marcar ausência e a vez dele chegar.
function AvulsoWaitingModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal payment-alert-modal" onClick={(e) => e.stopPropagation()}>
        <div className="payment-alert-icon"><Emo e="⏳" /></div>
        <h2 className="modal-title payment-alert-title">{AVULSO_WAITING_MESSAGE.title}</h2>
        {AVULSO_WAITING_MESSAGE.lines.map((line, i) => (
          <p key={i} className="payment-alert-body">
            {line}
          </p>
        ))}
        <button className="btn btn-primary btn-block" onClick={onClose}>
          Entendi
        </button>
      </div>
    </div>
  );
}

// Pop-up pro avulso promovido ANTES das 12h de segunda — mesmo modelo do
// aviso de espera, só avisando pra ficar de olho no fechamento da lista.
function PromotedEarlyModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal payment-alert-modal" onClick={(e) => e.stopPropagation()}>
        <div className="payment-alert-icon"><Emo e="🔔" /></div>
        <h2 className="modal-title payment-alert-title">{AVULSO_PROMOTED_EARLY_MESSAGE.title}</h2>
        {AVULSO_PROMOTED_EARLY_MESSAGE.lines.map((line, i) => (
          <p key={i} className="payment-alert-body">
            {line}
          </p>
        ))}
        <button className="btn btn-primary btn-block" onClick={onClose}>
          Entendi
        </button>
      </div>
    </div>
  );
}

// Pop-up mostrado a primeira vez que a pessoa abre o app depois que um
// admin vincula o login dela a um card — avisa que já pode usar tudo, e
// puxa pra ler as regras da pelada.
function WelcomeModal({ playerName, onClose, onReadRules }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal payment-alert-modal" onClick={(e) => e.stopPropagation()}>
        <div className="payment-alert-icon"><Emo e="⚽" /></div>
        <h2 className="modal-title payment-alert-title">
          Bem-vindo{playerName ? `, ${playerName}` : ""}!
        </h2>
        <p className="payment-alert-body">
          Seu login foi vinculado ao seu card — já pode interagir com tudo por aqui:
          colocar suas fotos, alterar seu perfil e confirmar presença nas peladas
          disponíveis.
        </p>
        <p className="payment-alert-body">
          Antes de mais nada, dá uma lida nas regras da pelada. <Emo e="👇" />
        </p>
        <button className="btn btn-primary btn-block" onClick={onReadRules}>
          <Emo e="📖" /> Ler as regras
        </button>
        <button className="btn btn-ghost btn-block" onClick={onClose}>
          Entendi
        </button>
      </div>
    </div>
  );
}

// Pop-up mostrado assim que a conta é criada — já fecha o "Minha conta" e
// volta pra home, e esse aviso aparece por cima explicando o próximo passo
// (pedir pro admin vincular o login ao card).
function SignupLinkAlertModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal payment-alert-modal" onClick={(e) => e.stopPropagation()}>
        <div className="payment-alert-icon"><Emo e="✅" /></div>
        <h2 className="modal-title payment-alert-title">Conta criada!</h2>
        <p className="payment-alert-body">
          Se você faz parte da Pelada 4K, avise um administrador pra ele vincular seu
          login ao seu card na lista de jogadores.
        </p>
        <p className="payment-alert-body">
          Sem isso você consegue ver a lista, mas não confirmar presença nem editar seu
          perfil.
        </p>
        <button className="btn btn-primary btn-block" onClick={onClose}>
          Entendi
        </button>
      </div>
    </div>
  );
}

// Pop-up pro mensalista que voltou tarde demais (depois de segunda 12h) e
// caiu pra fila de avulso — mesmo modelo do aviso de espera do avulso.
function LateRejoinModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal payment-alert-modal" onClick={(e) => e.stopPropagation()}>
        <div className="payment-alert-icon"><Emo e="⚠️" /></div>
        <h2 className="modal-title payment-alert-title">{LATE_REJOIN_MESSAGE.title}</h2>
        {LATE_REJOIN_MESSAGE.lines.map((line, i) => (
          <p key={i} className="payment-alert-body">
            {line}
          </p>
        ))}
        <button className="btn btn-primary btn-block" onClick={onClose}>
          Entendi
        </button>
      </div>
    </div>
  );
}

// Pop-up pro mensalista que não respondeu até segunda 13h e foi colocado
// como ausente pelo sistema. Só aparece na própria segunda, uma vez.
function AutoAbsentModal({ onClose, onJoinAvulso }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal payment-alert-modal" onClick={(e) => e.stopPropagation()}>
        <div className="payment-alert-icon"><Emo e="⏰" /></div>
        <h2 className="modal-title payment-alert-title">Opa!!!</h2>
        <p className="payment-alert-body">
          O prazo para confirmar presença na lista principal terminou (segunda, 13h) e seu nome foi
          incluído na lista de ausentes automaticamente pelo sistema.
        </p>
        <p className="payment-alert-body">
          Se quiser jogar, você ainda pode colocar seu nome na lista de avulsos.
        </p>
        <button className="btn btn-primary btn-block" onClick={onJoinAvulso}>
          ENTRAR NA LISTA DE AVULSOS
        </button>
        <button className="btn btn-ghost btn-block" onClick={onClose}>
          Fechar
        </button>
      </div>
    </div>
  );
}

// Popup público (qualquer pessoa pode abrir, pelo botão "Interesse
// Mensalista" na home): lista de quem quer virar mensalista, do mais
// antigo pro mais novo. Atualiza sozinha em tempo real conforme jogadores
// pedem interesse ou viram mensalista (somem da lista). Só leitura — quem
// aprova/recusa é o admin, pelo modal dele (MembershipInterestModal).
// Admin: caixa de seleção pra incluir membros na lista de interessados.
// Só aparecem membros avulsos que ainda não estão na lista. Dá pra marcar
// vários e incluir de uma vez (entram na fila na ordem em que foram marcados).
function InterestAddBox({ available, onAdd }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState([]); // ids, na ordem marcada
  const [saving, setSaving] = useState(false);
  const sorted = [...available].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const q = search.trim().toLowerCase();
  const shown = q ? sorted.filter((p) => displayName(p).toLowerCase().includes(q)) : sorted;
  const toggle = (id) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const close = () => {
    setOpen(false);
    setSearch("");
    setSelected([]);
  };
  const confirm = async () => {
    if (selected.length === 0) return;
    setSaving(true);
    await onAdd(selected);
    setSaving(false);
    close();
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-block interest-add-trigger" onClick={() => setOpen(true)}>
        <Emo e="➕" /> Incluir membros na lista de interesse
      </button>
    );
  }

  return (
    <div className="interest-add-box">
      <div className="interest-add-head">
        <span className="interest-add-title">Membros avulsos</span>
        <button type="button" className="link" onClick={close}>
          cancelar
        </button>
      </div>
      <input
        className="input"
        placeholder="Buscar…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="interest-add-list">
        {shown.map((p) => {
          const order = selected.indexOf(p.id);
          const checked = order !== -1;
          return (
            <li key={p.id}>
              <button
                type="button"
                className={`interest-add-option ${checked ? "is-checked" : ""}`}
                onClick={() => toggle(p.id)}
              >
                <span className="interest-add-check">{checked ? order + 1 : ""}</span>
                <Avatar player={p} shape="round" size={30} />
                <span className="presence-name">{displayName(p)}</span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && (
          <p className="empty-hint">
            {available.length === 0
              ? "Todos os membros avulsos já estão na lista."
              : "Ninguém encontrado."}
          </p>
        )}
      </ul>
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={selected.length === 0 || saving}
        onClick={confirm}
      >
        {saving
          ? "Incluindo…"
          : selected.length === 0
          ? "Selecione os membros"
          : `Incluir ${selected.length} na lista`}
      </button>
    </div>
  );
}

// Nome na fila de interessados — quem está ativo como mensalista temporário
// aparece com "(Fulano · Outubro/2026)": no lugar de quem entrou e o mês da
// troca, mais o selo 🔄.
function InterestQueueName({ player, info }) {
  return (
    <>
      <span className="presence-name">
        {displayName(player)}
        {info && (
          <span className="interest-temp-paren">
            {" "}
            ({info.replacedName}
            {info.month ? ` · ${info.month}` : ""})
          </span>
        )}
      </span>
      {info && <span className="temp-mensalista-tag"><Emo e="🔄" /> mensalista temporário</span>}
    </>
  );
}

function PublicInterestModal({ list, tempInfo, addedByName, availableToAdd, onAdd, onClose, canRequest, alreadyRequested, onRequest }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="🏅" /> Interessados em ser mensalista</h2>
        {onAdd && <InterestAddBox available={availableToAdd} onAdd={onAdd} />}
        <ul className="presence-list">
          {list.map((p, i) => (
            <li key={p.id} className={`presence-row ${tempInfo(p) ? "interest-row-temp" : ""}`}>
              <span className="presence-num">{i + 1}</span>
              <Avatar player={p} shape="round" size={34} />
              <div className="interest-row-info">
                <InterestQueueName player={p} info={tempInfo(p)} />
                <span className="interest-row-date">
                  {addedByName && addedByName(p) ? "incluído" : "pedido"} em{" "}
                  {new Date(p.membershipInterestAt).toLocaleDateString("pt-BR")}
                  {addedByName && addedByName(p) && (
                    <span className="interest-added-by"> — {addedByName(p)}</span>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
        {list.length === 0 && (
          <p className="empty-hint">Ninguém manifestou interesse em ser mensalista ainda.</p>
        )}
        {canRequest && !alreadyRequested && (
          <button className="btn btn-primary btn-block" onClick={onRequest}>
            <Emo e="🏅" /> Tenho interesse em ser mensalista
          </button>
        )}
        {canRequest && alreadyRequested && (
          <p className="field-hint"><Emo e="✅" /> Seu pedido já está na lista.</p>
        )}
        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin: lista de quem pediu pra virar mensalista, do mais antigo pro mais
// novo — aprovar vira mensalista automaticamente (aparece no card, some da
// lista); recusar só limpa o pedido, a pessoa continua avulsa.
function MembershipInterestModal({
  list,
  tempInfo,
  availableToAdd,
  addedByName,
  onAdd,
  onApprove,
  onDismiss,
  onMoveUp,
  onMoveDown,
  onClose,
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="🏅" /> Interessados em ser mensalista</h2>
        {list.length > 0 && (
          <p className="field-hint">
            Use as setas pra mudar a ordem da fila — quem está mais em cima sobe primeiro pra
            mensalista.
          </p>
        )}
        <InterestAddBox available={availableToAdd} onAdd={onAdd} />
        {list.length === 0 && <p className="empty-hint">Ninguém manifestou interesse ainda.</p>}
        <ul className="presence-list">
          {list.map((p, i) => (
            <li key={p.id} className={`presence-row ${tempInfo(p) ? "interest-row-temp" : ""}`}>
              <div className="reorder-btns">
                <button
                  type="button"
                  className="reorder-btn"
                  disabled={i === 0}
                  onClick={() => onMoveUp(p.id)}
                  aria-label={`Mover ${displayName(p)} pra cima`}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="reorder-btn"
                  disabled={i === list.length - 1}
                  onClick={() => onMoveDown(p.id)}
                  aria-label={`Mover ${displayName(p)} pra baixo`}
                >
                  ▼
                </button>
              </div>
              <span className="presence-num">{i + 1}</span>
              <Avatar player={p} shape="round" size={34} />
              <div className="interest-row-info">
                <InterestQueueName player={p} info={tempInfo(p)} />
                <span className="interest-row-date">
                  {addedByName(p) ? "incluído" : "pedido"} em{" "}
                  {new Date(p.membershipInterestAt).toLocaleDateString("pt-BR")}
                  {addedByName(p) && <span className="interest-added-by"> — {addedByName(p)}</span>}
                </span>
              </div>
              {/* Temporário é controlado pela aba Mensalistas (voltou / efetivar /
                  voltar pra interessados) — aqui só mantém o lugar na fila. */}
              {!tempInfo(p) && (
                <>
                  <button className="link presence-remove" onClick={() => onDismiss(p.id)}>
                    recusar
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={() => onApprove(p.id)}>
                    Aprovar
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

// Pop-up de confirmação genérico pras ações do admin que mudam alguém de
// posição/lista (mensalista ↔ avulso, temporário, etc.).
function ConfirmActionModal({ title, children, confirmLabel = "SIM", danger = false, onConfirm, onCancel }) {
  return (
    <div
      className="modal-backdrop"
      style={{ zIndex: 10000, alignItems: "center" }}
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="modal" style={{ borderRadius: 22, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>
        <div className="field-hint" style={{ fontSize: 15 }}>{children}</div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            NÃO
          </button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin: controle direto de quem é mensalista. Cada mensalista tem dois
// botões — "tornar avulso" (quem sobe da lista de interessados vira
// mensalista definitivo) e "tornar avulso temporário" (quem sobe fica
// vinculado à vaga e volta pra lista de interessados, na mesma posição,
// quando o mensalista original retornar). Também tem um campo pra promover
// qualquer jogador na hora, sem passar pelo pedido de interesse.
function MensalistaControlModal({
  mensalistas,
  interestList,
  availableToPromote,
  replacedNameFor,
  onDemote,
  onReplace,
  onMakeTemp,
  onPromote,
  onRestoreOriginal,
  onEndTemp,
  onMakeTempPermanent,
  onClose,
}) {
  const [addValue, setAddValue] = useState("");
  // Troca em andamento: { mensalista, temporary } — abre a caixa de escolha
  // de quem sobe da lista de interessados.
  const [swap, setSwap] = useState(null);
  // Ação aguardando confirmação: { title, text, danger, run }.
  const [pending, setPending] = useState(null);
  const askConfirm = (title, text, run, danger = false) => setPending({ title, text, run, danger });
  const confirmModal = pending ? (
    <ConfirmActionModal
      title={pending.title}
      danger={pending.danger}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const run = pending.run;
        setPending(null);
        run();
      }}
    >
      {pending.text}
    </ConfirmActionModal>
  ) : null;
  // Goleiros não pagam mensalidade — ficam separados no fim da lista, pra
  // não atrapalhar o controle dos mensalistas de linha.
  const lineMensalistas = mensalistas.filter((p) => !p.isGK);
  const gkMensalistas = mensalistas.filter((p) => p.isGK);
  const tempCount = lineMensalistas.filter(isTempMensalista).length;

  if (swap) {
    const { mensalista, temporary } = swap;
    const pick = (interestedId) => {
      const chosen = interestList.find((x) => x.id === interestedId);
      askConfirm(
        "Opa!!!",
        <>
          <strong>{displayName(mensalista)}</strong> vira avulso e <strong>{chosen ? displayName(chosen) : "o escolhido"}</strong> sobe
          como mensalista {temporary ? "temporário" : "definitivo"}. Confirmar?
        </>,
        () => {
          if (temporary) onMakeTemp(interestedId, mensalista.id);
          else onReplace(mensalista.id, interestedId);
          setSwap(null);
        }
      );
    };
    return (
      <div className="modal-backdrop" onClick={() => setSwap(null)}>
        {confirmModal}
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2 className="modal-title">
            {temporary ? emo("🔄 Tornar avulso temporário") : emo("⬇️ Tornar avulso")}
          </h2>
          <p className="field-hint">
            <strong>{displayName(mensalista)}</strong> vai virar avulso. Quem sobe da lista de
            interessados pro lugar dele?{" "}
            {temporary
              ? `Quem subir fica como mensalista temporário — quando ${displayName(
                  mensalista
                )} voltar, ele retorna pra lista de interessados na mesma posição.`
              : "Quem subir vira mensalista definitivo."}
          </p>
          <ul className="presence-list temp-pick-list">
            {interestList.map((p, i) => (
              <li key={p.id}>
                <button type="button" className="temp-pick-option" onClick={() => pick(p.id)}>
                  <span className="presence-num">{i + 1}</span>
                  <Avatar player={p} shape="round" size={34} />
                  <span className="presence-name">{displayName(p)}</span>
                </button>
              </li>
            ))}
            {interestList.length === 0 && (
              <p className="empty-hint">Ninguém na lista de interessados no momento.</p>
            )}
          </ul>
          <div className="modal-actions">
            {!temporary && (
              <button
                className="link link-danger"
                onClick={() =>
                  askConfirm(
                    "Opa!!!",
                    <>
                      <strong>{displayName(mensalista)}</strong> vira avulso e ninguém sobe pro lugar dele. Confirmar?
                    </>,
                    () => {
                      onDemote(mensalista.id);
                      setSwap(null);
                    },
                    true
                  )
                }
              >
                só tornar avulso (ninguém sobe)
              </button>
            )}
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setSwap(null)}>
              Voltar
            </button>
          </div>
        </div>
      </div>
    );
  }

  const renderRow = (p) =>
    isTempMensalista(p) ? (
      <li key={p.id} className="presence-row temp-mensalista-row">
        <Avatar player={p} shape="round" size={34} />
        <div className="interest-row-info">
          <span className="presence-name">{displayName(p)}</span>
          <span className="temp-mensalista-tag"><Emo e="🔄" /> temporário · no lugar de {replacedNameFor(p)}</span>
          <div className="temp-mensalista-actions">
            <button type="button" className="mens-btn mens-btn-green" onClick={() =>
                askConfirm(
                  "Opa!!!",
                  <>
                    <strong>{replacedNameFor(p)}</strong> volta a ser mensalista e <strong>{displayName(p)}</strong> volta pra lista de
                    interessados na posição de antes. Confirmar?
                  </>,
                  () => onRestoreOriginal(p)
                )
              }>
              {replacedNameFor(p)} voltou
            </button>
            <button type="button" className="mens-btn mens-btn-gold" onClick={() =>
                askConfirm(
                  "Opa!!!",
                  <>
                    <strong>{displayName(p)}</strong> deixa de ser temporário e fica como mensalista definitivo. Confirmar?
                  </>,
                  () => onMakeTempPermanent(p.id)
                )
              }>
              efetivar
            </button>
            <button type="button" className="mens-btn mens-btn-danger" onClick={() =>
                askConfirm(
                  "Opa!!!",
                  <>
                    <strong>{displayName(p)}</strong> deixa de ser mensalista temporário e volta pra lista de interessados. Confirmar?
                  </>,
                  () => onEndTemp(p.id),
                  true
                )
              }>
              voltar pra interessados
            </button>
          </div>
        </div>
      </li>
    ) : (
      <li key={p.id} className="presence-row">
        <Avatar player={p} shape="round" size={34} />
        <div className="interest-row-info">
          <span className="presence-name">{displayName(p)}</span>
          <div className="temp-mensalista-actions">
            <button
              type="button"
              className="mens-btn mens-btn-danger"
              onClick={() => setSwap({ mensalista: p, temporary: false })}
            >
              tornar avulso
            </button>
            <button
              type="button"
              className="mens-btn mens-btn-gold"
              onClick={() => setSwap({ mensalista: p, temporary: true })}
            >
              tornar avulso temporário
            </button>
          </div>
        </div>
      </li>
    );
  return (
    <div className="modal-backdrop" onClick={onClose}>
      {confirmModal}
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="🎖️" /> Mensalistas</h2>
        <p className="admin-hint">
          {lineMensalistas.length} mensalista{lineMensalistas.length === 1 ? "" : "s"} no momento
          {tempCount > 0 && ` (${tempCount} temporário${tempCount === 1 ? "" : "s"})`}
          {gkMensalistas.length > 0 &&
            ` + ${gkMensalistas.length} goleiro${gkMensalistas.length === 1 ? "" : "s"}`}
          .
        </p>
        <ul className="presence-list">
          {lineMensalistas.map(renderRow)}
          {lineMensalistas.length === 0 && <p className="empty-hint">Nenhum mensalista ainda.</p>}
        </ul>
        {gkMensalistas.length > 0 && (
          <>
            <GroupTitle kind="gk">GOLEIROS</GroupTitle>
            <p className="field-hint">Goleiros não pagam mensalidade.</p>
            <ul className="presence-list">{gkMensalistas.map(renderRow)}</ul>
          </>
        )}
        {availableToPromote.length > 0 && (
          <div className="presence-add-row">
            <select className="input" value={addValue} onChange={(e) => setAddValue(e.target.value)}>
              <option value="">+ tornar alguém mensalista…</option>
              {availableToPromote.map((p) => (
                <option key={p.id} value={p.id}>
                  {displayName(p)}
                </option>
              ))}
            </select>
            <button
              className="btn btn-ghost btn-sm"
              disabled={!addValue}
              onClick={() => {
                const chosen = availableToPromote.find((x) => x.id === addValue);
                askConfirm(
                  "Opa!!!",
                  <>
                    <strong>{chosen ? displayName(chosen) : "O jogador"}</strong> vira mensalista. Confirmar?
                  </>,
                  () => {
                    onPromote(addValue);
                    setAddValue("");
                  }
                );
              }}
            >
              Tornar
            </button>
          </div>
        )}
        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin: caixa de sugestões — mensagens que qualquer pessoa logada manda
// (pelo "Minha conta") pedindo melhoria no sistema ou na pelada, sempre
// identificadas com quem mandou.
function SuggestionsModal({ suggestions, loading, onDelete, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="💡" /> Sugestões</h2>
        <p className="admin-hint">
          Recados que o pessoal manda pelo "Minha conta" — pra melhorar o app ou a pelada.
        </p>
        {loading ? (
          <p className="empty-hint">Carregando…</p>
        ) : suggestions.length === 0 ? (
          <p className="empty-hint">Nenhuma sugestão por enquanto.</p>
        ) : (
          <ul className="suggestion-list">
            {suggestions.map((s) => (
              <li key={s.id} className="suggestion-item">
                <div className="suggestion-item-head">
                  <span className="suggestion-item-author">{s.author_name}</span>
                  <span className="suggestion-item-date">
                    {new Date(s.created_at).toLocaleDateString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                {s.author_email && <div className="suggestion-item-email">{s.author_email}</div>}
                <p className="suggestion-item-message">{s.message}</p>
                <button className="link link-danger" onClick={() => onDelete(s.id)}>
                  excluir
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin: gerencia quem tem acesso de administrador — lista todo mundo que
// já criou conta (tabela "profiles") com um botão pra promover/remover.
// Quem está logado não consegue remover o próprio acesso por aqui (evita
// se trancar fora sem querer) — outro admin remove, se precisar.
function AdminControlModal({ profiles, adminUserIds, myUserId, onGrant, onRevoke, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="👑" /> Administradores</h2>
        <p className="admin-hint">
          Quem tem acesso de administrador consegue publicar peladas, editar qualquer
          jogador, controlar pagamentos e promover/remover outros administradores.
        </p>
        <ul className="presence-list">
          {profiles.map((pr) => {
            const isAdminAccount = adminUserIds.has(pr.id);
            const isSelf = pr.id === myUserId;
            return (
              <li key={pr.id} className="presence-row">
                <div className="interest-row-info">
                  <span className="presence-name">{pr.fullName || pr.email}</span>
                  <span className="interest-row-date">{pr.email}</span>
                </div>
                {isAdminAccount ? (
                  <button
                    className="paid-pill paid-pill-paid"
                    disabled={isSelf}
                    title={isSelf ? "Você não pode remover seu próprio acesso" : undefined}
                    onClick={() => onRevoke(pr.id)}
                  >
                    <Emo e="👑" /> admin
                  </button>
                ) : (
                  <button className="paid-pill paid-pill-pending" onClick={() => onGrant(pr.id)}>
                    tornar admin
                  </button>
                )}
              </li>
            );
          })}
          {profiles.length === 0 && <p className="empty-hint">Ninguém criou conta ainda.</p>}
        </ul>
        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin: controle de pagamento — aba "Mensalistas" (mensalidade do mês
// corrente, um registro por mês) e aba "Avulsos" (pagamento avulso da
// pelada aberta, um registro por pelada). Também é onde liga/desliga o
// bloqueio de acesso do mensalista inadimplente.
function PaymentControlModal({
  monthLabel,
  mensalistas,
  membershipPayments,
  onToggleMensalistaPaid,
  blockUnpaidEnabled,
  onToggleBlockUnpaid,
  avulsoEntries,
  hasPelada,
  onToggleAvulsoPaid,
  replacedNameFor,
  pixSettings,
  onSavePixSettings,
  adminProfiles,
  myUserId,
  onClose,
}) {
  const [tab, setTab] = useState("mensalistas"); // mensalistas | avulsos | pix
  const paidCount = mensalistas.filter((p) => membershipPayments[p.id]?.paid).length;

  // ---- PIX do mês ----
  const pixAccounts = pixSettings?.accounts || [];
  const activePix = activePixFrom(pixSettings);
  const [newPixName, setNewPixName] = useState("");
  const [newPixKey, setNewPixKey] = useState("");
  const [pixSaving, setPixSaving] = useState(false);
  const savePix = async (next) => {
    setPixSaving(true);
    await onSavePixSettings(next);
    setPixSaving(false);
  };
  const addPixAccount = async () => {
    const name = newPixName.trim();
    const key = newPixKey.trim();
    if (!name || !key) return;
    const account = { id: crypto.randomUUID(), name, key };
    // Primeiro PIX cadastrado já vira o ativo (e o PIX padrão antigo fica
    // salvo na lista pra voltar com um toque); os próximos ficam salvos pra
    // trocar quando quiser.
    const base = pixAccounts.length > 0 ? pixAccounts : [{ ...PIX_INFO }];
    await savePix({
      accounts: [...base, account],
      activeId: pixAccounts.length > 0 ? pixSettings.activeId : account.id,
    });
    setNewPixName("");
    setNewPixKey("");
  };
  const removePixAccount = async (id) => {
    const accounts = pixAccounts.filter((a) => a.id !== id);
    const activeId = pixSettings?.activeId === id ? accounts[0]?.id ?? null : pixSettings?.activeId;
    await savePix({ accounts, activeId });
  };
  // Editar nome/chave de um PIX já cadastrado (ex.: completar a chave)
  const listedPix = pixAccountsOf(pixSettings);
  const [editingPixId, setEditingPixId] = useState(null);
  const [editPixName, setEditPixName] = useState("");
  const [editPixKey, setEditPixKey] = useState("");
  const startEditPix = (a) => {
    setEditingPixId(a.id);
    setEditPixName(a.name || "");
    setEditPixKey(a.key || "");
  };
  const saveEditPix = async () => {
    const name = editPixName.trim();
    if (!name) return;
    const accounts = listedPix.map((a) =>
      a.id === editingPixId ? { ...a, name, key: editPixKey.trim() } : a
    );
    await savePix({ accounts, activeId: pixSettings?.activeId || activePix.id });
    setEditingPixId(null);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="💳" /> Controle de pagamentos</h2>

        <div className="payment-tabs">
          <button
            className={`payment-tab ${tab === "mensalistas" ? "payment-tab-active" : ""}`}
            onClick={() => setTab("mensalistas")}
          >
            Mensalistas
          </button>
          <button
            className={`payment-tab ${tab === "avulsos" ? "payment-tab-active" : ""}`}
            onClick={() => setTab("avulsos")}
          >
            Avulsos da pelada
          </button>
          <button
            className={`payment-tab ${tab === "pix" ? "payment-tab-active" : ""}`}
            onClick={() => setTab("pix")}
          >
            PIX do mês
          </button>
        </div>

        {tab === "pix" && (
          <>
            <p className="admin-hint">
              Escolha pra qual PIX vão os pagamentos deste mês. Todas as cobranças (mensalidade e
              avulso) passam a mostrar o PIX ativo na hora, pra todo mundo. Cada conta PIX é um
              caixa no Financeiro: todo pagamento marcado como pago entra no caixa do PIX ativo.
            </p>
            <div className="pix-active-card">
              <span className="pix-active-label">PIX ATIVO</span>
              <span className="pix-active-name">{activePix.name}</span>
              <span className="pix-active-key">{activePix.key}</span>
              <span className="pix-active-owner">
                <Emo e="💰" /> Pagamentos marcados como pago entram no caixa deste PIX (aba Financeiro)
              </span>
            </div>

            <ul className="presence-list">
              {listedPix.map((a) => {
                const isActive = a.id === activePix.id;
                const hasKey = !!(a.key || "").trim();
                if (editingPixId === a.id) {
                  return (
                    <li key={a.id} className="presence-row pix-edit-row">
                      <div className="interest-row-info">
                        <input
                          className="input"
                          placeholder="Nome de quem recebe"
                          value={editPixName}
                          onChange={(e) => setEditPixName(e.target.value)}
                        />
                        <input
                          className="input pix-key-input"
                          placeholder="Chave PIX (e-mail, CPF, telefone…)"
                          value={editPixKey}
                          onChange={(e) => setEditPixKey(e.target.value)}
                        />
                        <div className="temp-mensalista-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={pixSaving || !editPixName.trim() || (isActive && !editPixKey.trim())}
                            onClick={saveEditPix}
                          >
                            Salvar
                          </button>
                          <button type="button" className="link" onClick={() => setEditingPixId(null)}>
                            cancelar
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                }
                return (
                  <li key={a.id} className="presence-row">
                    <div className="interest-row-info">
                      <span className="presence-name">{a.name}</span>
                      <span className={`interest-row-date ${hasKey ? "" : "pix-missing-key"}`}>
                        {hasKey ? a.key : emo("⚠️ falta cadastrar a chave PIX")}
                      </span>
                      <div className="temp-mensalista-actions">
                        <button type="button" className="link" disabled={pixSaving} onClick={() => startEditPix(a)}>
                          editar
                        </button>
                        {!isActive && pixAccounts.length > 0 && (
                          <button
                            type="button"
                            className="link link-danger"
                            disabled={pixSaving}
                            onClick={() => {
                              if (window.confirm(`Remover o PIX de ${a.name}?`)) removePixAccount(a.id);
                            }}
                          >
                            remover
                          </button>
                        )}
                      </div>
                    </div>
                    {isActive ? (
                      <span className="paid-pill paid-pill-paid"><Emo e="✔" /> ativo</span>
                    ) : (
                      <button
                        className="paid-pill paid-pill-pending"
                        disabled={pixSaving || !hasKey}
                        title={hasKey ? undefined : "Cadastre a chave antes de usar"}
                        onClick={() => savePix({ accounts: listedPix, activeId: a.id })}
                      >
                        usar este mês
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>

            <p className="presence-group-title">+ Cadastrar PIX</p>
            <input
              className="input"
              placeholder="Nome de quem recebe"
              value={newPixName}
              onChange={(e) => setNewPixName(e.target.value)}
            />
            <input
              className="input pix-key-input"
              placeholder="Chave PIX (e-mail, CPF, telefone…)"
              value={newPixKey}
              onChange={(e) => setNewPixKey(e.target.value)}
            />
            <button
              className="btn btn-primary btn-block"
              disabled={pixSaving || !newPixName.trim() || !newPixKey.trim()}
              onClick={addPixAccount}
            >
              {pixAccounts.length === 0 ? "Salvar e usar este mês" : "Salvar PIX"}
            </button>
          </>
        )}

        {tab === "mensalistas" && (
          <>
            <p className="admin-hint">
              Mensalidade de <strong>{monthLabel}</strong> — {paidCount}/{mensalistas.length} pagas.
            </p>

            <label className="switch-row block-unpaid-row">
              <span><Emo e="🔒" /> Bloquear acesso à lista de quem não pagou</span>
              <button
                type="button"
                className={`toggle ${blockUnpaidEnabled ? "toggle-on" : ""}`}
                onClick={onToggleBlockUnpaid}
                aria-pressed={blockUnpaidEnabled}
              >
                <span className="toggle-knob" />
              </button>
            </label>
            <p className="field-hint">
              Ligado: mensalista com a mensalidade do mês em aberto não consegue confirmar
              presença nem marcar ausência — vê só o aviso de pagamento até você marcar como pago.
            </p>

            <ul className="presence-list">
              {mensalistas.map((p) => {
                const paid = !!membershipPayments[p.id]?.paid;
                return (
                  <li key={p.id} className="presence-row">
                    <Avatar player={p} shape="round" size={34} />
                    <div className="interest-row-info">
                      <span className="presence-name">{displayName(p)}</span>
                      {isTempMensalista(p) && (
                        <span className="temp-mensalista-tag"><Emo e="🔄" /> no lugar de {replacedNameFor(p)}</span>
                      )}
                      {!paid && p.membershipReportedMonth === currentMonthKey() && (
                        <span className="reported-paid-tag"><Emo e="💬" /> informou que já pagou</span>
                      )}
                    </div>
                    <button
                      className={`paid-pill ${paid ? "paid-pill-paid" : "paid-pill-pending"}`}
                      onClick={() => onToggleMensalistaPaid(p.id, !paid)}
                    >
                      {paid ? emo("✔ pago") : "pendente"}
                    </button>
                  </li>
                );
              })}
              {mensalistas.length === 0 && <p className="empty-hint">Nenhum mensalista ainda.</p>}
            </ul>
          </>
        )}

        {tab === "avulsos" && (
          <>
            {!hasPelada && <p className="empty-hint">Nenhuma pelada publicada no momento.</p>}
            {hasPelada && (
              <>
                <p className="admin-hint">Pagamento avulso (R$ 30,00) da pelada aberta.</p>
                <ul className="presence-list">
                  {avulsoEntries.map((entry) => {
                    const name = entry.kind === "player" ? displayName(entry.player) : entry.presence.guest_name;
                    const paid = !!entry.presence.paid;
                    return (
                      <li key={entry.presence.id} className="presence-row">
                        {entry.kind === "player" && <Avatar player={entry.player} shape="round" size={34} />}
                        <span className="presence-name">{name}</span>
                        <button
                          className={`paid-pill ${paid ? "paid-pill-paid" : "paid-pill-pending"}`}
                          onClick={() => onToggleAvulsoPaid(entry.presence.id, !paid)}
                        >
                          {paid ? emo("✔ pago") : "pendente"}
                        </button>
                      </li>
                    );
                  })}
                  {avulsoEntries.length === 0 && (
                    <p className="empty-hint">Nenhum avulso confirmado nessa pelada ainda.</p>
                  )}
                </ul>
              </>
            )}
          </>
        )}

        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin: controle financeiro — cada CONTA PIX é um caixa. Todo pagamento
// marcado como pago entra no caixa da "conta do mês" (o PIX ativo, que é o
// mesmo mostrado nas cobranças); os admins escolhem essa conta no box do
// topo. Registros antigos ficam no caixa do PIX do Felipe. Organizado por mês: mensalidades (nome + valor + PAGO) e avulsos
// separados por pelada (1ª pelada · data, 2ª pelada · data…). Qualquer admin
// pode mover um recebimento de caixa, estornar, e lançar/remover saídas em
// qualquer caixa. O total geral embaixo soma todos os caixas.
const ORDINAL_PT = (n) => `${n}ª`;
const shortDateBR = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" })
    : "";

function FinanceIncomeRow({ name, amount, sub, caixas, currentOwner, onMove, onRefund }) {
  const [editing, setEditing] = useState(false);
  return (
    <li className="finance-row finance-income-row">
      <div className="finance-row-main">
        <span className="finance-row-label">{name}</span>
        <span className="finance-row-amount finance-in">{formatBRL(amount)}</span>
        <span className="paid-pill paid-pill-paid finance-paid-pill">PAGO</span>
      </div>
      <div className="finance-row-sub">
        <span>{sub}</span>
        <button type="button" className="link finance-edit-link" onClick={() => setEditing((v) => !v)}>
          {editing ? "fechar" : "editar"}
        </button>
      </div>
      {editing && (
        <div className="finance-row-edit">
          <select
            className="input"
            value={currentOwner || ""}
            onChange={(e) => {
              if (e.target.value) {
                onMove(e.target.value);
                setEditing(false);
              }
            }}
          >
            {caixas.map((c) => (
              <option key={c.id} value={c.id}>
                Mover pro caixa: PIX {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="link link-danger"
            onClick={() => {
              if (window.confirm(`Estornar o pagamento de ${name}? Ele volta a ficar pendente.`)) {
                onRefund();
              }
            }}
          >
            estornar pagamento
          </button>
        </div>
      )}
    </li>
  );
}

function FinanceControlModal({
  loading,
  mensalidades,
  avulsos,
  expenses,
  peladas,
  players,
  adminProfiles,
  myUserId,
  onAddExpense,
  onDeleteExpense,
  onMoveIncome,
  onRefundIncome,
  pixSettings,
  onSetMonthCaixa,
  onClose,
}) {
  // Caixas = contas PIX. "Conta do mês" = PIX ativo (o das cobranças).
  const caixas = pixAccountsOf(pixSettings);
  const monthCaixaId = activePixFrom(pixSettings).id || PIX_INFO.id;
  const legacyCaixaId = legacyCaixaIdOf(pixSettings);
  const caixaName = (id) => caixas.find((c) => c.id === id)?.name || "PIX removido";
  // Abre direto no caixa da conta do mês
  const [viewingAdminId, setViewingAdminId] = useState(monthCaixaId);
  const [savingMonthCaixa, setSavingMonthCaixa] = useState(false);
  const [expenseDesc, setExpenseDesc] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");

  const nameFor = (playerId) => {
    const p = players.find((pl) => pl.id === playerId);
    return p ? displayName(p) : "Jogador removido";
  };
  const adminNameFor = (userId) => {
    const pr = adminProfiles.find((a) => a.id === userId);
    return pr ? pr.fullName || pr.email : "—";
  };
  // Sem caixa (registro antigo) ou com o id do PIX padrão que não está na
  // lista com esse id → caixa do PIX do Felipe.
  const normCaixa = (id) =>
    !id || (id === PIX_INFO.id && !caixas.some((c) => c.id === id)) ? legacyCaixaId : id;
  const caixaOfMensalidade = (m) => normCaixa(m.caixa_id);
  const caixaOfAvulso = (a) => normCaixa(a.caixa_id);
  const caixaOfExpense = (e) => normCaixa(e.caixa_id);
  // Recebimentos/saídas de um PIX que foi removido da lista continuam
  // aparecendo: entram como caixa próprio no seletor.
  const orphanCaixaIds = [
    ...new Set(
      [
        ...mensalidades.map(caixaOfMensalidade),
        ...avulsos.map(caixaOfAvulso),
        ...expenses.map(caixaOfExpense),
      ].filter((id) => !caixas.some((c) => c.id === id))
    ),
  ];

  // Data de cada pelada (agendada; se não tiver, quando foi publicada)
  const peladaById = new Map((peladas || []).map((p) => [p.id, p]));
  const peladaDate = (peladaId) => {
    const p = peladaById.get(peladaId);
    return p ? p.scheduled_for || p.created_at : null;
  };

  // Número da pelada dentro do mês (1ª, 2ª…), contando todas as peladas
  // daquele mês em ordem de data — não só as que tiveram avulso pago.
  const peladaNumberInMonth = (peladaId) => {
    const date = peladaDate(peladaId);
    if (!date) return null;
    const key = currentMonthKey(new Date(date));
    const sameMonth = (peladas || [])
      .filter((p) => {
        const d = p.scheduled_for || p.created_at;
        return d && currentMonthKey(new Date(d)) === key;
      })
      .sort((a, b) => new Date(a.scheduled_for || a.created_at) - new Date(b.scheduled_for || b.created_at));
    return sameMonth.findIndex((p) => p.id === peladaId) + 1 || null;
  };

  // ---- Caixa em visualização, organizado por mês ----
  const myMensalidades = mensalidades.filter((m) => caixaOfMensalidade(m) === viewingAdminId);
  const myAvulsos = avulsos.filter((a) => caixaOfAvulso(a) === viewingAdminId);

  const months = new Map(); // "YYYY-MM" -> { mensalidades: [], peladas: Map(peladaId -> []) }
  const monthBucket = (key) => {
    if (!months.has(key)) months.set(key, { mensalidades: [], peladas: new Map() });
    return months.get(key);
  };
  myMensalidades.forEach((m) => monthBucket(m.month).mensalidades.push(m));
  myAvulsos.forEach((a) => {
    const date = peladaDate(a.pelada_id) || a.paid_at;
    const key = date ? currentMonthKey(new Date(date)) : "sem-data";
    const bucket = monthBucket(key);
    if (!bucket.peladas.has(a.pelada_id)) bucket.peladas.set(a.pelada_id, []);
    bucket.peladas.get(a.pelada_id).push(a);
  });
  const monthKeys = [...months.keys()].sort((a, b) => b.localeCompare(a));

  const viewingIncomeTotal =
    myMensalidades.length * MENSALIDADE_VALUE + myAvulsos.length * AVULSO_VALUE;
  const viewingExpenses = expenses
    .filter((e) => caixaOfExpense(e) === viewingAdminId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const viewingExpensesTotal = viewingExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const viewingCaixaFinal = viewingIncomeTotal - viewingExpensesTotal;

  const totalIncomeAll = mensalidades.length * MENSALIDADE_VALUE + avulsos.length * AVULSO_VALUE;
  const totalExpensesAll = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const totalGeral = totalIncomeAll - totalExpensesAll;

  const submitExpense = () => {
    const amount = Number(expenseAmount.replace(",", "."));
    if (!expenseDesc.trim() || !amount || amount <= 0) return;
    onAddExpense(expenseDesc.trim(), amount, viewingAdminId);
    setExpenseDesc("");
    setExpenseAmount("");
  };

  const checkedBy = (userId, at) =>
    [userId ? `check por ${adminNameFor(userId)}` : null, at ? shortDateBR(at) : null]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal finance-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="💰" /> Controle financeiro</h2>

        {loading ? (
          <p className="admin-hint">Carregando…</p>
        ) : (
          <>
            <div className="finance-month-caixa">
              <label className="finance-month-caixa-label" htmlFor="finance-month-caixa-select">
                <Emo e="📌" /> Conta do mês
              </label>
              <select
                id="finance-month-caixa-select"
                className="input"
                value={monthCaixaId}
                disabled={savingMonthCaixa || caixas.length < 2}
                onChange={async (e) => {
                  const id = e.target.value;
                  setSavingMonthCaixa(true);
                  await onSetMonthCaixa(id);
                  setSavingMonthCaixa(false);
                  setViewingAdminId(id);
                }}
              >
                {caixas.map((c) => (
                  <option key={c.id} value={c.id} disabled={!(c.key || "").trim()}>
                    PIX {c.name} — {(c.key || "").trim() ? c.key : "falta cadastrar a chave"}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                As cobranças mostram esse PIX, e todo pagamento marcado como pago entra no caixa dele.
                {caixas.length < 2 &&
                  " Pra ter outra conta pra escolher, cadastre o PIX em Pagamentos → PIX do mês."}
              </p>
            </div>

            <label className="field-label" htmlFor="finance-admin-select">
              Ver caixa
            </label>
            <select
              id="finance-admin-select"
              className="input"
              value={viewingAdminId || ""}
              onChange={(e) => setViewingAdminId(e.target.value)}
            >
              {caixas.map((c) => (
                <option key={c.id} value={c.id}>
                  PIX {c.name}
                  {c.id === monthCaixaId ? " · conta do mês" : ""}
                </option>
              ))}
              {orphanCaixaIds.map((id) => (
                <option key={id} value={id}>
                  PIX removido ({id.slice(0, 6)})
                </option>
              ))}
            </select>

            <p className="presence-group-title"><Emo e="📥" /> Recebimentos</p>
            {monthKeys.length === 0 && (
              <p className="empty-hint">Nenhum recebimento nesse caixa ainda.</p>
            )}
            {monthKeys.map((key, idx) => {
              const bucket = months.get(key);
              const monthTotal =
                bucket.mensalidades.length * MENSALIDADE_VALUE +
                [...bucket.peladas.values()].reduce((sum, list) => sum + list.length * AVULSO_VALUE, 0);
              const peladaIds = [...bucket.peladas.keys()].sort(
                (a, b) => new Date(peladaDate(a) || 0) - new Date(peladaDate(b) || 0)
              );
              return (
                <details key={key} className="finance-month" open={idx === 0}>
                  <summary className="finance-month-head">
                    <span>{key === "sem-data" ? "Sem data" : monthKeyLabel(key)}</span>
                    <span className="finance-in">{formatBRL(monthTotal)}</span>
                  </summary>

                  {bucket.mensalidades.length > 0 && (
                    <>
                      <p className="finance-section-title"><Emo e="🏅" /> Mensalidades</p>
                      <ul className="finance-list">
                        {[...bucket.mensalidades]
                          .sort((a, b) => nameFor(a.player_id).localeCompare(nameFor(b.player_id)))
                          .map((m) => (
                            <FinanceIncomeRow
                              key={`m-${m.player_id}-${m.month}`}
                              name={nameFor(m.player_id)}
                              amount={MENSALIDADE_VALUE}
                              sub={checkedBy(m.updated_by, m.paid_at)}
                              caixas={caixas}
                              currentOwner={caixaOfMensalidade(m)}
                              onMove={(owner) => onMoveIncome("mensalidade", m, owner)}
                              onRefund={() => onRefundIncome("mensalidade", m)}
                            />
                          ))}
                      </ul>
                    </>
                  )}

                  {peladaIds.length > 0 && (
                    <>
                      <p className="finance-section-title"><Emo e="🎟️" /> Avulsos</p>
                      {peladaIds.map((pid) => {
                        const list = bucket.peladas.get(pid);
                        const n = peladaNumberInMonth(pid);
                        const isExtra = peladaById.get(pid)?.kind === "extra";
                        return (
                          <div key={pid || "sem-pelada"} className="finance-pelada">
                            <p className="finance-pelada-title">
                              {n ? `${ORDINAL_PT(n)} pelada` : "Pelada"}
                              {isExtra ? " (extra)" : ""}
                              {peladaDate(pid) ? ` · ${shortDateBR(peladaDate(pid))}` : ""}
                              <span className="finance-pelada-total">{formatBRL(list.length * AVULSO_VALUE)}</span>
                            </p>
                            <ul className="finance-list">
                              {[...list]
                                .sort((a, b) =>
                                  (a.player_id ? nameFor(a.player_id) : a.guest_name || "").localeCompare(
                                    b.player_id ? nameFor(b.player_id) : b.guest_name || ""
                                  )
                                )
                                .map((a) => (
                                  <FinanceIncomeRow
                                    key={`a-${a.id}`}
                                    name={a.player_id ? nameFor(a.player_id) : `${a.guest_name} (convidado)`}
                                    amount={AVULSO_VALUE}
                                    sub={checkedBy(a.paid_by, a.paid_at)}
                                    caixas={caixas}
                                    currentOwner={caixaOfAvulso(a)}
                                    onMove={(owner) => onMoveIncome("avulso", a, owner)}
                                    onRefund={() => onRefundIncome("avulso", a)}
                                  />
                                ))}
                            </ul>
                          </div>
                        );
                      })}
                    </>
                  )}
                </details>
              );
            })}
            <p className="finance-subtotal">Total recebido: {formatBRL(viewingIncomeTotal)}</p>

            <p className="presence-group-title"><Emo e="📤" /> Saídas</p>
            <ul className="finance-list">
              {viewingExpenses.map((e) => (
                <li key={e.id} className="finance-row">
                  <span className="finance-row-label">{e.description}</span>
                  <span className="finance-row-amount finance-out">-{formatBRL(Number(e.amount))}</span>
                  <button
                    className="link link-danger presence-remove"
                    onClick={() => {
                      if (window.confirm(`Remover a saída "${e.description}"?`)) onDeleteExpense(e.id);
                    }}
                  >
                    remover
                  </button>
                </li>
              ))}
              {viewingExpenses.length === 0 && <p className="empty-hint">Nenhuma saída registrada.</p>}
            </ul>
            <div className="finance-add-row">
              <input
                className="input"
                placeholder="Descrição do gasto"
                value={expenseDesc}
                onChange={(e) => setExpenseDesc(e.target.value)}
              />
              <input
                className="input finance-amount-input"
                placeholder="Valor"
                inputMode="decimal"
                value={expenseAmount}
                onChange={(e) => setExpenseAmount(e.target.value)}
              />
              <button className="btn btn-ghost btn-sm" onClick={submitExpense}>
                Registrar
              </button>
            </div>
            <p className="finance-subtotal">Total de saídas: {formatBRL(viewingExpensesTotal)}</p>

            <div className="finance-final-box">
              <span>Caixa final — PIX {caixaName(viewingAdminId)}</span>
              <span className={viewingCaixaFinal < 0 ? "finance-out" : "finance-in"}>
                {formatBRL(viewingCaixaFinal)}
              </span>
            </div>

            <div className="finance-final-box finance-final-box-geral">
              <span><Emo e="💰" /> Total geral (todos os caixas)</span>
              <span className={totalGeral < 0 ? "finance-out" : "finance-in"}>{formatBRL(totalGeral)}</span>
            </div>
          </>
        )}

        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

function PresenceHistoryModal({ history, loading, players, onClose, onReopen }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="📜" /> Histórico de presença</h2>
        {loading && <p className="admin-hint">Carregando…</p>}
        {!loading && history.length === 0 && (
          <p className="empty-hint">Nenhuma pelada encerrada ainda.</p>
        )}
        {!loading &&
          history.map(({ pelada: p, presences: pr }) => {
            const confirmed = pr
              .filter((x) => x.status === "confirmed" && x.player_id)
              .map((x) => players.find((pl) => pl.id === x.player_id))
              .filter(Boolean);
            const gks = confirmed.filter((pl) => pl.isGK);
            const nonGks = confirmed.filter((pl) => !pl.isGK);
            const guests = pr.filter((x) => x.guest_name);
            const absent = pr
              .filter((x) => x.status === "absent" && x.player_id)
              .map((x) => players.find((pl) => pl.id === x.player_id))
              .filter(Boolean);
            return (
              <details key={p.id} className="history-item">
                <summary className="history-summary">
                  <span>
                    {p.kind === "extra" && <span className="history-kind-badge">EXTRA</span>}
                    {p.status === "deleted" && <span className="history-kind-badge history-kind-badge-deleted">EXCLUÍDA</span>}
                    {p.scheduledFor
                      ? new Date(p.scheduledFor).toLocaleString("pt-BR", {
                          weekday: "short",
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "Sem data"}
                    {p.location ? ` · ${p.location}` : ""}
                  </span>
                  <span className="history-counts">
                    <Emo e="✅" /> {confirmed.length} · <Emo e="🔔" /> {guests.length} · <Emo e="❌" /> {absent.length}
                  </span>
                </summary>
                {onReopen && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-block history-reopen-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      onReopen(p);
                    }}
                  >
                    <Emo e="↩" /> Reabrir esta lista
                  </button>
                )}
                {gks.length > 0 && (
                  <>
                    <GroupTitle kind="gk">GOLEIROS</GroupTitle>
                    <ul className="presence-list">
                      {gks.map((pl) => (
                        <li key={pl.id} className="presence-row">
                          <span className="presence-num"><Emo e="🥅" /></span>
                          <span className="presence-name">{displayName(pl)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <GroupTitle kind="ok">CONFIRMADOS</GroupTitle>
                <ul className="presence-list">
                  {nonGks.map((pl, i) => (
                    <li key={pl.id} className="presence-row">
                      <span className="presence-num">{i + 1}</span>
                      <span className="presence-name">{displayName(pl)}</span>
                    </li>
                  ))}
                  {nonGks.length === 0 && <p className="empty-hint">Ninguém confirmou.</p>}
                </ul>
                {guests.length > 0 && (
                  <>
                    <GroupTitle kind="ticket">AVULSOS</GroupTitle>
                    <ul className="presence-list">
                      {guests.map((g, i) => (
                        <li key={g.id} className="presence-row">
                          <span className="presence-num">{i + 1}</span>
                          <span className="presence-name">{g.guest_name}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {absent.length > 0 && (
                  <>
                    <GroupTitle kind="out">M. AUSENTES</GroupTitle>
                    <ul className="presence-list">
                      {absent.map((pl, i) => (
                        <li key={pl.id} className="presence-row">
                          <span className="presence-num">{i + 1}</span>
                          <span className="presence-name">{displayName(pl)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </details>
            );
          })}
        <div className="modal-actions">
          <button className="btn btn-primary btn-block" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

// Barra de ações do admin — organizada em chips do mesmo tamanho, em vez de
// links de texto soltos quebrando linha de qualquer jeito.
function AdminToolbar({
  hasPelada,
  onPublishPelada,
  hasPeladaExtra,
  onPublishPeladaExtra,
  onDeletePeladaExtra,
  onHistory,
  onInterestList,
  interestCount,
  onPaymentControl,
  onMensalistaControl,
  mensalistaCount,
  onAdminControl,
  onStopwatch,
  onAnnouncement,
  onFinance,
  onSuggestions,
  suggestionsCount,
  onSorteio,
  onDeletePelada,
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const items = [
    {
      key: "sorteio",
      icon: emo("🎲"),
      label: "Sorteio de times",
      onClick: onSorteio,
    },
    {
      key: "publish",
      icon: emo("📋"),
      label: hasPelada ? "Publicar outra pelada" : "Publicar nova pelada",
      onClick: onPublishPelada,
    },
    {
      key: "publish-extra",
      icon: emo("⚡"),
      label: hasPeladaExtra ? "Outra pelada extra" : "Publicar pelada extra",
      onClick: onPublishPeladaExtra,
    },
    hasPeladaExtra && {
      key: "delete-extra",
      icon: emo("🗑️"),
      label: "Excluir extra",
      onClick: onDeletePeladaExtra,
      danger: true,
    },
    { key: "announcement", icon: emo("📢"), label: "Aviso", onClick: onAnnouncement },
    { key: "history", icon: emo("📜"), label: "Histórico", onClick: onHistory },
    {
      key: "interest",
      icon: emo("🏅"),
      label: "Interessados",
      onClick: onInterestList,
      count: interestCount,
    },
    {
      key: "mensalistas",
      icon: emo("🎖️"),
      label: "Mensalistas",
      onClick: onMensalistaControl,
      count: mensalistaCount,
    },
    { key: "payments", icon: emo("💳"), label: "Pagamentos", onClick: onPaymentControl },
    { key: "finance", icon: emo("💰"), label: "Financeiro", onClick: onFinance },
    {
      key: "suggestions",
      icon: emo("💡"),
      label: "Sugestões",
      onClick: onSuggestions,
      count: suggestionsCount,
    },
    { key: "admins", icon: emo("👑"), label: "Administradores", onClick: onAdminControl },
    { key: "stopwatch", icon: emo("⏱"), label: "Cronômetro (publicar na home)", onClick: onStopwatch },
    hasPelada && {
      key: "delete",
      icon: emo("🗑️"),
      label: "Excluir lista",
      onClick: onDeletePelada,
      danger: true,
    },
  ].filter(Boolean);

  return (
    <div className="admin-menu" ref={boxRef}>
      <button
        type="button"
        className={`admin-menu-trigger ${open ? "is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="admin-menu-trigger-icon"><Emo e="⚽" /></span>
        MENU
        <span className="admin-menu-trigger-caret">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="admin-menu-panel">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              className={`admin-menu-item ${it.danger ? "admin-menu-item-danger" : ""}`}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <span className="admin-menu-item-icon">{it.icon}</span>
              <span className="admin-menu-item-label">{it.label}</span>
              {it.count > 0 && <span className="count-pill count-pill-sm">{it.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Ícones desenhados (no lugar de emoji) — estilo do layout FIFA/PES =====
const EMO_SVG = {
  ball: <><circle cx="12" cy="12" r="9" /><path d="M12 8.2l3.4 2.5-1.3 4h-4.2l-1.3-4z" /><path d="M12 8.2V3.2M15.4 10.7l4.7-1.5M14.1 14.7l2.9 4M9.9 14.7l-2.9 4M8.6 10.7L3.9 9.2" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  checkc: <><circle cx="12" cy="12" r="9" /><path d="M8 12.3l2.8 2.8 5.5-5.6" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  xc: <><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  glove: <><path d="M7 13V6.5a1.5 1.5 0 0 1 3 0V11" /><path d="M10 11V4.5a1.5 1.5 0 0 1 3 0V11" /><path d="M13 11V5.5a1.5 1.5 0 0 1 3 0V12" /><path d="M16 12V8.5a1.5 1.5 0 0 1 3 0V15c0 4-2.6 6.5-6.5 6.5S7 19 7 15.5L4.6 12.6a1.5 1.5 0 0 1 2.3-1.9L7 11" /><path d="M8 18h8" /></>,
  stopwatch: <><circle cx="12" cy="13.5" r="7.5" /><path d="M12 9.5v4l2.5 1.5M9.5 2.5h5M12 2.5V6M18.4 6.3l1.4-1.4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  hourglass: <><path d="M6.5 3.5h11M6.5 20.5h11" /><path d="M7.5 3.5c0 4 3 5.5 4.5 8.5-1.5 3-4.5 4.5-4.5 8.5M16.5 3.5c0 4-3 5.5-4.5 8.5 1.5 3 4.5 4.5 4.5 8.5" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" /></>,
  medal: <><circle cx="12" cy="15" r="5.5" /><path d="M8.2 3.5L10.6 10M15.8 3.5L13.4 10" /><path d="M12 12.6l.9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3z" /></>,
  coin: <><circle cx="12" cy="12" r="9" /><path d="M14.6 9.3c-.6-.8-1.5-1.3-2.6-1.3-1.4 0-2.5.8-2.5 1.9 0 2.7 5.2 1.3 5.2 4 0 1.1-1.1 2-2.7 2-1.1 0-2.1-.5-2.7-1.3M12 6v2M12 16v2" /></>,
  bell: <><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  clip: <><rect x="5" y="4.5" width="14" height="17" rx="2" /><path d="M9 4.5v-1h6v1M8.5 10h7M8.5 14h7M8.5 17.5h4" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21" /></>,
  dice: <><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1" fill="currentColor" /><circle cx="15" cy="9" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="9" cy="15" r="1" fill="currentColor" /><circle cx="15" cy="15" r="1" fill="currentColor" /></>,
  warn: <><path d="M12 3.5l9.5 16.5h-19z" /><path d="M12 10v4.5M12 17.3v.2" /></>,
  crown: <path d="M3.5 18.5l-1-11 5 4.5 4.5-7 4.5 7 5-4.5-1 11z" />,
  together: <><circle cx="9" cy="12" r="5" /><circle cx="15" cy="12" r="5" /></>,
  pin: <><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  book: <path d="M4 5.5A2 2 0 0 1 6 4h6v15H6a2 2 0 0 0-2 1.5zM20 5.5A2 2 0 0 0 18 4h-6v15h6a2 2 0 0 1 2 1.5z" />,
  doc: <><path d="M6 3.5h9l3.5 3.5v13.5H6z" /><path d="M14.5 3.5V7.5h4M9 12h6M9 15.5h6" /></>,
  card: <><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h4" /></>,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  share: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>,
  cal: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  bolt: <path d="M13 2.5L4.5 13.5h6l-1 8 9-11.5h-6z" />,
  tv: <><rect x="3" y="6.5" width="18" height="12.5" rx="2" /><path d="M8.5 3l3.5 3.5L15.5 3" /></>,
  camera: <><path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z" /><circle cx="12" cy="13.5" r="3.5" /></>,
  video: <><rect x="3" y="6.5" width="12.5" height="11" rx="2" /><path d="M15.5 10.5l5.5-3v9l-5.5-3z" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="9.5" r="1.6" /><path d="M3.5 17l5-5 4 4 3-3 5 5" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20c.8-4 3.8-6 7.5-6s6.7 2 7.5 6" /></>,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chat: <path d="M4 5.5h16v11H10l-4.5 4v-4H4z" />,
  inbox: <path d="M12 4v10M7.5 10l4.5 4.5 4.5-4.5M5 19h14" />,
  outbox: <path d="M12 15V5M7.5 9L12 4.5 16.5 9M5 19h14" />,
  ticket: <><path d="M3 8.5V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2.5a2.5 2.5 0 0 0 0 5V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.5a2.5 2.5 0 0 0 0-5z" /><path d="M14.5 5v2M14.5 11v2M14.5 17v2" /></>,
  scale: <><path d="M12 4v16M6 20h12M5 7h14" /><path d="M5 7l-2.5 7a3 3 0 0 0 5 0zM19 7l-2.5 7a3 3 0 0 0 5 0z" /></>,
  undo: <path d="M9 6.5L4.5 11 9 15.5M5 11h9a5 5 0 0 1 0 10h-3" />,
  heart: <path d="M12 21s-8.5-5-8.5-11A4.8 4.8 0 0 1 12 7.2 4.8 4.8 0 0 1 20.5 10c0 6-8.5 11-8.5 11z" />,
  laugh: <><circle cx="12" cy="12" r="9" /><path d="M8.3 9.3h.01M15.7 9.3h.01" /><path d="M7.8 13.5h8.4a4.2 4.2 0 0 1-8.4 0z" /></>,
  fire: <path d="M12 3c.5 3.5 4.5 5.5 4.5 10a4.5 4.5 0 0 1-9 0c0-2 1-3 2-4 .3 1.2.8 1.8 1.5 2C11 8.5 11.5 5.5 12 3z" />,
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />,
  wow: <><circle cx="12" cy="12" r="9" /><path d="M8.3 9.3h.01M15.7 9.3h.01" /><ellipse cx="12" cy="15.5" rx="2" ry="2.6" /></>,
  sad: <><circle cx="12" cy="12" r="9" /><path d="M8.3 9.3h.01M15.7 9.3h.01" /><path d="M8.5 16.5c1-1.5 2.2-2 3.5-2s2.5.5 3.5 2" /></>,
  thumb: <path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.2 2.5L12.7 10H19a1.8 1.8 0 0 1 1.7 2.2l-1.5 6.5A2 2 0 0 1 17.2 20H7" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  trash: <path d="M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13M10 11v6M14 11v6" />,
  pencil: <path d="M4 20l1-4.5L16.5 4 20 7.5 8.5 19zM14.5 6l3.5 3.5" />,
  phone: <path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 5.5a2 2 0 0 1 2-2z" />,
  star: <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  unlock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 7.5-2" /></>,
  bulb: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />,
  mega: <path d="M3.5 10.5v3h3.5l8 4.5v-12l-8 4.5zM17.5 9.5a4 4 0 0 1 0 5M7 13.5l1 5h2.5l-1-4.5" />,
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
};
const EMO_MAP = {
  "⚽": "ball", "✓": "check", "✔": "check", "✅": "checkc", "✕": "x", "✖": "x", "❌": "xc", "🧤": "glove", "🥅": "glove",
  "🕐": "clock", "⏱": "stopwatch", "⏰": "clock", "⏳": "hourglass", "🔄": "refresh", "🏅": "medal", "🎖": "medal", "💰": "coin", "🔔": "bell",
  "📋": "clip", "🔍": "search", "🎲": "dice", "⚠": "warn", "👑": "crown", "🤝": "together", "📍": "pin", "📌": "pin",
  "📖": "book", "📜": "doc", "💳": "card", "⬆": "up", "⬇": "down", "👇": "down", "📲": "share", "🚫": "ban", "🗓": "cal", "📅": "cal",
  "⚡": "bolt", "📺": "tv", "📷": "camera", "🎥": "video", "🖼": "image", "👤": "user", "⚙": "gear", "➕": "plus", "💬": "chat",
  "📥": "inbox", "📤": "outbox", "🎟": "ticket", "⚖": "scale", "↩": "undo", "❤": "heart", "🤍": "heart", "😂": "laugh",
  "🔥": "fire", "👏": "spark", "🙌": "spark", "😮": "wow", "😢": "sad", "👍": "thumb", "👁": "eye", "🗑": "trash", "✎": "pencil",
  "📞": "phone", "⭐": "star", "★": "star", "🔒": "lock", "🔓": "unlock", "💡": "bulb", "📢": "mega",
};
const EMO_DOT = { "⚫": "#EDEDED", "🟠": "#FF8A3D", "⚪": "#AFC3D6", "🔴": "#e0243f" };
const EMO_FILLED = new Set(["heart", "star", "crown", "bolt", "fire", "spark", "thumb", "mega"]);
const EMO_RE = /(?:\p{Extended_Pictographic}|[✓✔✕✖↩✎★⚙➕⏳])️?[\u{1F3FB}-\u{1F3FF}]?/gu;
function Emo({ e }) {
  const base = String(e).replace(/[️\u{1F3FB}-\u{1F3FF}]/gu, "");
  if (EMO_DOT[base]) return <span className="emo emo-dot" style={{ background: EMO_DOT[base] }} aria-hidden="true" />;
  const name = EMO_MAP[base];
  if (!name) return null;
  const filled = base !== "🤍" && (EMO_FILLED.has(name) || base === "❤");
  return (
    <svg className={`emo emo-${name}`} viewBox="0 0 24 24" width="1.1em" height="1.1em" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {EMO_SVG[name]}
    </svg>
  );
}
// converte um texto com emoji em texto + ícones desenhados
function emo(str) {
  if (typeof str !== "string") return str;
  const out = [];
  let last = 0, k = 0, m;
  EMO_RE.lastIndex = 0;
  while ((m = EMO_RE.exec(str))) {
    if (m.index > last) out.push(str.slice(last, m.index));
    out.push(<Emo key={k++} e={m[0]} />);
    last = m.index + m[0].length;
  }
  if (!out.length) return str;
  if (last < str.length) out.push(str.slice(last));
  return <>{out.map((x, i) => (typeof x === "string" ? <React.Fragment key={"t" + i}>{x}</React.Fragment> : x))}</>;
}

// Título de grupo da lista (ícones próprios no lugar de emoji) — layout FIFA/PES
const GROUP_ICONS = {
  gk: <><path d="M7 13V6.5a1.5 1.5 0 0 1 3 0V11" /><path d="M10 11V4.5a1.5 1.5 0 0 1 3 0V11" /><path d="M13 11V5.5a1.5 1.5 0 0 1 3 0V12" /><path d="M16 12V8.5a1.5 1.5 0 0 1 3 0V15c0 4-2.6 6.5-6.5 6.5S7 19 7 15.5L4.6 12.6a1.5 1.5 0 0 1 2.3-1.9L7 11" /><path d="M8 18h8" /></>,
  ok: <><path d="M12 3l7.5 2.8V12c0 4.2-3.1 7.4-7.5 9-4.4-1.6-7.5-4.8-7.5-9V5.8L12 3z" /><path d="M8.6 12.2l2.4 2.4 4.6-5" /></>,
  ticket: <><path d="M3 8.5V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2.5a2.5 2.5 0 0 0 0 5V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.5a2.5 2.5 0 0 0 0-5z" /><path d="M14.5 5v2M14.5 11v2M14.5 17v2" /><path d="M8 10.5v3M6.5 12h3" /></>,
  out: <><path d="M12 3l7.5 2.8V12c0 4.2-3.1 7.4-7.5 9-4.4-1.6-7.5-4.8-7.5-9V5.8L12 3z" /><path d="M9.2 9.4l5.6 5.6M14.8 9.4l-5.6 5.6" /></>,
};
function GroupTitle({ kind, children }) {
  return (
    <p className={`presence-group-title presence-group-${kind}`}>
      <svg className="pgt-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {GROUP_ICONS[kind]}
      </svg>
      <span>{children}</span>
    </p>
  );
}

// Banner grande e animado — chama atenção pra pelada aberta sem já jogar o
// conteúdo inteiro da lista na tela.
function PresenceOpenBanner({ onOpen, title = "LISTA ABERTA", cta = "ACESSE AQUI", className = "" }) {
  return (
    <button className={`presence-open-banner ${className}`} onClick={onOpen}>
      <span className="pob-in">
        <span className="pob-left">
          <span className="pob-live"><i className="pob-dot" />AO VIVO</span>
          <span className="presence-open-banner-title">{title}</span>
        </span>
        <span className="presence-open-banner-cta">{cta}<i className="pob-arrow" /></span>
      </span>
    </button>
  );
}

// Banner igual ao da lista de presença, só que vermelho — chama atenção pra
// escalação já sorteada sem jogar os times inteiros na tela.
function EscalacaoBanner({ onOpen, concluded }) {
  const nextPeladaLabel = concluded ? nextMondayLabelBRT().dayMonth : null;
  return (
    <button
      className={`presence-open-banner escalacao-banner ${concluded ? "escalacao-banner-concluded" : ""}`}
      onClick={onOpen}
    >
      <span className="pob-in">
        <span className="pob-left"><span className="pob-live"><i className="pob-dot" />AO VIVO</span><span className="presence-open-banner-title">ESCALAÇÃO DEFINIDA</span></span>
        <span className="presence-open-banner-cta">ACESSE AQUI<i className="pob-arrow" /></span>
      </span>
      {concluded && (
        <span className="escalacao-banner-concluded-note">
          <span className="escalacao-banner-check"><Emo e="✔" /></span>
          PELADA CONCLUÍDA · Próxima pelada {nextPeladaLabel}
        </span>
      )}
    </button>
  );
}

// Pop-up com a escalação sorteada — times bem separados, com o resumo de
// equilíbrio embaixo. Clicar no nome de alguém abre o card dela.
function EscalacaoModal({ list, isAdmin, hasPelada, onClose: onCloseProp, onSeePresence, onUnpublish, onViewPlayer }) {
  const onClose = () => fxClose(onCloseProp);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal escalacao-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="🔴" /> ESCALAÇÃO DEFINIDA</h2>

        <div className="presence-page-card escalacao-header-card">
          <div className="presence-page-card-head">
            <img src={LOGO_DATA_URL} alt="Pelada 4K" className="presence-page-logo" />
            <div className="presence-page-card-headcol">
              <h2 className="presence-page-card-title">PELADA 4K</h2>
              <div className="presence-page-card-info">
                <div className="presence-page-card-row">
                  <span className="presence-page-card-icon"><CalendarIcon /></span>
                  <span className="presence-page-card-value">SEGUNDA</span>
                </div>
                <div className="presence-page-card-row">
                  <span className="presence-page-card-icon"><ClockIcon /></span>
                  <span className="presence-page-card-value">21:00</span>
                </div>
                <div className="presence-page-card-row">
                  <span className="presence-page-card-icon"><PinIcon /></span>
                  <span className="presence-page-card-value">Arena Paris - PSG - BH</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="escalacao-teams">
          {list.teams.map((t) => (
            <section key={t.key} className="team-card" style={{ "--team-color": t.color }}>
              <div className="team-card-head">
                <span className="team-card-title">
                  {emo(t.emoji)} {t.label.toUpperCase()}
                </span>
              </div>
              <ul className="team-player-list">
                {t.players.map((p) => (
                  <li key={p.id} className="team-player-row">
                    <Avatar player={p} shape="square" size={38} />
                    <span
                      className="team-player-name presence-name-clickable"
                      onClick={() => onViewPlayer(p)}
                    >
                      {displayName(p)} {list.considerGK && p.isGK ? emo("🧤") : ""}
                    </span>
                    <Stars count={starsFilled(p.rating)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="escalacao-modal-actions">
          {hasPelada && (
            <button className="btn btn-ghost btn-block" onClick={onSeePresence}>
              <Emo e="📋" /> Ver lista de presença
            </button>
          )}
          <button className="btn btn-primary btn-block" onClick={onClose}>
            Fechar
          </button>
          {isAdmin && (
            <button className="link link-danger" onClick={onUnpublish}>
              excluir lista
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Texto das regras — cada item vira um parágrafo, com *assim* virando
// negrito. Editar aqui é editar o conteúdo da página de regras.
const RULES_META = [
  "🗓️ Segundas, 21h às 22:30",
  "📍 Quadra Arena PSG - Estoril",
  "⚠️ Não falar de política",
];
const RULES_UPDATED_AT = "REGRAS ATUALIZADAS MAIO/25 ⚽️";
const RULES_ITEMS = [
  "*Mão:* Seja colada, aberta ou sem querer. Região do cotovelo pra baixo, é FALTA = LATERAL",
  "*Mão intencional, recuada, mão/falta na área:* Tiro direto.",
  "*Mão INTENCIONAL na área*: Pênalti. Obs: Proibido bicuda. Deverá bater de chapa/colocado.(SIM, NOSSA PELADA É NUTELLA)",
  "*Falta:* pede quem sofre *NA HORA*. Passou o lance, perdeu a chance de pedir.",
  "*Saída de bola:* apenas com o time adversário em campo e não pode chutar direto.",
  "*Bola na rede superior:* lateral.",
  "*Lateral errado:* inverte para o adversário.",
  "*Tempo:* vamos marcar o tempo no cronômetro, sendo justo com os segundos. Não vale marcar no relógio apenas.",
  "*Empate:* sai o time que estava na quadra.",
  "*Tempo pausado:* sempre que alguém se machucar ou a bola sair da quadra pelos furos da tela.",
  "*Equilíbrio de times:* Fica definido a troca de peças chave após sorteio para equilíbrio e disputa saudável da pelada. Sabemos que em outras peladas não funciona assim, porém nossa turma é pequena e não somos 100% peladeiros. Portanto, contamos com a colaboração de todos quanto a isso, evitando piadas e falácias sobre o tema.",
  "*Pagamento Avulso:* Deverá ser feito até 14h da segunda-feira",
  "*Pagamento mensal:* Deverá ser feito *ATÉ A PRIMEIRA PELADA DO MÊS!* Após, multa 10$ por semana.",
  ("*Regra-mor do bom senso:* nossa pelada é pra divertir, de forma honesta e com disputa saudável. *Sem reclamações excessivas, sem molecagem.* Vamos resolver tudo considerando que estamos todos ali pra fugir do estresse e não entrar nele. 👍🏼"),
];
const RULES_CONTACT =
  "*Qualquer dúvida, sugestão ou demanda, deverá ser feita diretamente aos ADMs, Norman, Felipe Muniz ou Freitas.*";
const RULES_SIGNATURE = "ADM 2026/27";


// ===== TV PELADA 4K: canais de vídeo ao vivo (embed) cadastrados pelos admins =====
function tvEmbedUrl(raw) {
  let u = String(raw || "").trim();
  const m = u.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (m) u = m[1];
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https:\/\//i.test(u)) return null;
  let url;
  try { url = new URL(u); } catch { return null; }
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.split("/")[1];
    return id ? `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0` : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    let id = url.searchParams.get("v");
    if (!id && ["live", "embed", "shorts"].includes(parts[0]) && parts[1] && parts[1] !== "live_stream") id = parts[1];
    if (id) return `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0`;
    const ch = url.searchParams.get("channel") || (parts[0] === "channel" ? parts[1] : null);
    if (ch) return `https://www.youtube.com/embed/live_stream?channel=${ch}&autoplay=1&playsinline=1`;
    return null;
  }
  if (host === "twitch.tv") {
    const ch = url.pathname.split("/").filter(Boolean)[0];
    return ch ? `https://player.twitch.tv/?channel=${ch}&parent=${window.location.hostname}&autoplay=true` : null;
  }
  if (host === "player.twitch.tv" && !url.searchParams.get("parent")) {
    url.searchParams.set("parent", window.location.hostname);
    return url.toString();
  }
  return url.toString();
}

function TvLogo({ c }) {
  const [bad, setBad] = useState(false);
  if (c?.logo_url && !bad && /^https:\/\//i.test(c.logo_url)) {
    return <span className="tv-logo"><img src={c.logo_url} alt="" onError={() => setBad(true)} /></span>;
  }
  const ini = String(c?.name || "?").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return <span className="tv-logo tv-logo-ini">{ini}</span>;
}

function TvPage({ onBack, isAdmin }) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState(null);
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [logo, setLogo] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);

  const load = async () => {
    const { data: raw, error } = await supabase.from("tv_channels").select("*");
    const data = raw ? [...raw].sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-BR", { numeric: true, sensitivity: "base" })) : raw;
    if (!error && data) {
      setChannels(data);
      setCurrent((c) => (c && data.some((x) => x.id === c) ? c : data[0]?.id ?? null));
    }
    setLoading(false);
  };
  useEffect(() => {
    load();
    const ch = supabase.channel("tv-channels-rt").on("postgres_changes", { event: "*", schema: "public", table: "tv_channels" }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const add = async () => {
    setErr("");
    if (!name.trim()) { setErr("Dê um nome ao canal."); return; }
    if (!tvEmbedUrl(link)) { setErr("Link inválido. Use um link https (YouTube, Twitch ou o código embed)."); return; }
    setBusy(true);
    const row = { name: name.trim(), url: link.trim(), position: channels.length };
    if (logo.trim()) row.logo_url = logo.trim();
    const { error } = await supabase.from("tv_channels").insert(row);
    setBusy(false);
    if (error) { setErr("Não foi possível salvar: " + (error.message || "erro") + (/tv_channels/.test(error.message || "") ? " — rode a migração da TV no Supabase." : "")); return; }
    setName(""); setLink(""); setLogo(""); load();
  };
  const remove = async (id) => {
    if (!window.confirm("Excluir este canal?")) return;
    await supabase.from("tv_channels").delete().eq("id", id);
    load();
  };

  const setChannelLogo = async (c) => {
    const v = window.prompt("Link da imagem do logo (https://...). Deixe vazio para remover.", c.logo_url || "");
    if (v === null) return;
    const { error } = await supabase.from("tv_channels").update({ logo_url: v.trim() || null }).eq("id", c.id);
    if (error) setErr("Não foi possível salvar o logo: " + error.message);
    load();
  };
  const active = channels.find((c) => c.id === current);
  const src = active ? tvEmbedUrl(active.url) : null;

  return (
    <div className="rules-page tv-page">
      <div className="rules-page-header">
        <button className="hero-icon-btn" onClick={onBack} aria-label="Voltar">‹</button>
        <h1 className="rules-page-title">TV PELADA 4K</h1>
      </div>
      <div className="rules-page-body">
        {loading ? (
          <p className="empty-hint">Carregando…</p>
        ) : channels.length === 0 ? (
          <p className="empty-hint">Nenhum canal ao vivo cadastrado ainda.</p>
        ) : (
          <>
            <div className="tv-player">
              {src ? (
                <iframe key={active.id} src={src} title={active.name} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
              ) : (
                <p className="empty-hint">Link do canal inválido.</p>
              )}
            </div>
            <div className="tv-picker">
              <button className={`tv-select ${pickOpen ? "open" : ""}`} onClick={() => setPickOpen((v) => !v)}>
                {active ? <TvLogo c={active} /> : <span className="tv-chip-dot" />}
                <span className="tv-select-name">{active?.name || "Escolher canal"}</span>
                <span className="tv-select-caret">▾</span>
              </button>
              {pickOpen && (
                <>
                  <div className="tv-pick-back" onClick={() => setPickOpen(false)} />
                  <ul className="tv-pick-list">
                    {channels.map((c) => (
                      <li key={c.id}>
                        <button className={c.id === current ? "on" : ""} onClick={() => { setCurrent(c.id); setPickOpen(false); }}>
                          <TvLogo c={c} />{c.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </>
        )}

        {isAdmin && (
          <div className="tv-admin">
            <button className="btn btn-ghost btn-block" onClick={() => setManage((v) => !v)}>
              <Emo e="⚙" /> {manage ? "Fechar gerenciar canais" : "Gerenciar canais"}
            </button>
            {manage && (
              <div className="tv-admin-box">
                <label className="field-label">Nome do canal</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Quadra principal" />
                <label className="field-label">Link ao vivo ou código embed</label>
                <input className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://youtube.com/live/... ou twitch.tv/..." />
                <label className="field-label">Logo do canal (link da imagem, opcional)</label>
                <input className="input" value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://.../logo.png" />
                {err && <p className="field-hint tv-err">{err}</p>}
                <button className="btn btn-primary btn-block" disabled={busy} onClick={add}>{busy ? "Salvando…" : "Adicionar canal"}</button>
                <ul className="tv-list">
                  {channels.map((c) => (
                    <li key={c.id}>
                      <TvLogo c={c} /><span className="tv-list-name">{c.name}</span>
                      <button className="btn btn-ghost" onClick={() => setChannelLogo(c)}>Logo</button>
                      <button className="btn btn-ghost" onClick={() => remove(c.id)}>Excluir</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Página própria das regras (não é pop-up) — some o resto do app e mostra só
// isso, com um botão de voltar, igual qualquer outra tela do site.
function RulesPage({ onBack }) {
  return (
    <div className="rules-page">
      <div className="rules-page-header">
        <button className="hero-icon-btn" onClick={onBack} aria-label="Voltar">
          ‹
        </button>
        <h1 className="rules-page-title">REGRAS DA PELADA 4K</h1>
      </div>
      <div className="rules-page-body">
        <div className="rules-meta">
          {RULES_META.map((line, i) => (
            <p key={i} className="rules-meta-line">
              {emo(line)}
            </p>
          ))}
        </div>
        <p className="rules-updated">{emo(RULES_UPDATED_AT)}</p>
        <ol className="rules-list">
          {RULES_ITEMS.map((item, i) => (
            <li key={i} className="rules-item">
              {renderBoldText(item)}
            </li>
          ))}
        </ol>
        <p className="rules-contact">{renderBoldText(RULES_CONTACT)}</p>
        <p className="rules-signature">{RULES_SIGNATURE}</p>
      </div>
    </div>
  );
}

export default function PeladaApp() {
  const [players, setPlayers] = useState([]);
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState("roster"); // roster | select | config | result
  const [formPlayer, setFormPlayer] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [viewPlayer, setViewPlayer] = useState(null); // mini perfil (pop-up de visualização)
  const [memberSearch, setMemberSearch] = useState(""); // busca de membros na home
  const [memberSearchFocused, setMemberSearchFocused] = useState(false);
  const [showMyProfileForm, setShowMyProfileForm] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showSignupLinkAlert, setShowSignupLinkAlert] = useState(false);
  const [showWelcomeModal, setShowWelcomeModal] = useState(false);
  const [showSetNewPassword, setShowSetNewPassword] = useState(false);
  const [profiles, setProfiles] = useState([]); // só carregado quando é admin (pra vincular login)
  const [adminUserIds, setAdminUserIds] = useState(new Set()); // ids de quem é admin — só carregado quando é admin
  const [showAdminControl, setShowAdminControl] = useState(false);
  const [contacts, setContacts] = useState({}); // { [playerId]: phone } — admin vê tudo; comum só o próprio
  const [loadError, setLoadError] = useState(false);
  const [publishedList, setPublishedList] = useState(null);
  const [justPublished, setJustPublished] = useState(false);
  const [pelada, setPelada] = useState(null);
  const [presences, setPresences] = useState([]); // [{ playerId }]
  // Pelada extra: lista avulsa fora do cronograma semanal, publicada à parte
  // pelo admin — pode existir ao mesmo tempo que a pelada principal, sem
  // mexer nela. "Livre": qualquer jogador cadastrado confirma direto, sem
  // fila de avulso nem controle de mensalidade.
  const [peladaExtra, setPeladaExtra] = useState(null);
  const [presencesExtra, setPresencesExtra] = useState([]);
  const [showPresenceListModal, setShowPresenceListModal] = useState(false);
  const [showEscalacaoModal, setShowEscalacaoModal] = useState(false);
  const [showStopwatch, setShowStopwatch] = useState(false);
  const [swActor, setSwActor] = useState("Alguém");
  const sw = useSharedStopwatch(authUser, swActor);
  const swPush = usePushAlert(authUser);
  const [, setClk] = useState(0);
  useEffect(() => { const id = setInterval(() => setClk((n) => n + 1), 20000); return () => clearInterval(id); }, []);
  const swBannerOn = !!authUser && (sw.publishedDate === todayBRT() || (isStopwatchWindowBRT() && sw.hiddenDate !== todayBRT()));
  const loadAttendance = async () => {
    try {
      const { data } = await supabase.rpc("attendance_stats");
      if (Array.isArray(data)) setAttendanceRows(data);
    } catch {}
  };
  useEffect(() => { loadAttendance(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [showPublishPelada, setShowPublishPelada] = useState(false);
  const [showPublishPeladaExtra, setShowPublishPeladaExtra] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]); // [{ pelada, presences }]
  const [historyLoading, setHistoryLoading] = useState(false);
  const [cancelPresenceConfirm, setCancelPresenceConfirm] = useState(null); // "main" | "extra" | null
  const [paymentAlert, setPaymentAlert] = useState(null); // "avulso" | "mensalista" | null
  const [showInterestList, setShowInterestList] = useState(false);
  const [showPublicInterestList, setShowPublicInterestList] = useState(false);
  const [showPaymentControl, setShowPaymentControl] = useState(false);
  const [showMensalistaControl, setShowMensalistaControl] = useState(false);
  const [announcement, setAnnouncement] = useState(null);
  const [showAnnouncementPopup, setShowAnnouncementPopup] = useState(false);
  const [showAnnouncementAdmin, setShowAnnouncementAdmin] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false); // admin: caixa de sugestões
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsUnreadCount, setSuggestionsUnreadCount] = useState(0);
  // Stories: fotos/vídeos temporários (somem sozinhos depois de 24h),
  // igual Instagram — bolinhas no topo da Home.
  const [stories, setStories] = useState([]);
  const [uploadingStory, setUploadingStory] = useState(false);
  const [storyViewerPlayerId, setStoryViewerPlayerId] = useState(null);
  const [seenStoryIds, setSeenStoryIds] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("pelada4k_seen_stories") || "[]"));
    } catch {
      return new Set();
    }
  });
  const [membershipPayments, setMembershipPayments] = useState({}); // { [playerId]: { paid, paidAt } } — mês atual
  const [blockUnpaidEnabled, setBlockUnpaidEnabled] = useState(false);
  // PIX do mês escolhido pelo admin ({ accounts: [{id,name,key}], activeId })
  const [pixSettings, setPixSettings] = useState(null);
  const activePix = activePixFrom(pixSettings);
  const [showFinance, setShowFinance] = useState(false);
  const [financeLoading, setFinanceLoading] = useState(false);
  const [financeData, setFinanceData] = useState({ mensalidades: [], avulsos: [], expenses: [], peladas: [] });

  // Regras da Pelada 4K: página própria (não é pop-up) — mora no hash da URL
  // (#regras) pra ter link direto e voltar funcionar como em qualquer outra
  // página (botão "voltar" do navegador/celular fecha ela sozinho).
  const [showRulesPage, setShowRulesPage] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#regras"
  );
  useEffect(() => {
    const onHashChange = () => setShowRulesPage(window.location.hash === "#regras");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const openRulesPage = () => {
    window.location.hash = "regras";
  };
  const closeRulesPage = () => {
    if (window.location.hash === "#regras") fxClose(() => { window.location.hash = ""; });
  };

  const [showTvPage, setShowTvPage] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#tv"
  );
  useEffect(() => {
    const onHashChange = () => { const o = window.location.hash === "#tv"; setShowTvPage(o); if (o) window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const openTvPage = () => { window.location.hash = "tv"; };
  const closeTvPage = () => { if (window.location.hash === "#tv") fxClose(() => { window.location.hash = ""; }); };

  // Lista de presença: também é página própria (mesmo esquema de hash da
  // página de regras), não mais uma seção que abre dentro da home.
  const [showPresenceListPage, setShowPresenceListPage] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#lista"
  );
  useEffect(() => {
    const onHashChange = () => {
      const isOpen = window.location.hash === "#lista";
      setShowPresenceListPage(isOpen);
      // Navegar via hash não rola a página sozinho (não é um load de
      // verdade) — força pro topo pra não abrir "no meio" se a home estava
      // rolada, escondendo o cabeçalho da página nova.
      if (isOpen) window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const openPresenceListPage = () => {
    window.location.hash = "lista";
    window.scrollTo(0, 0);
  };
  const closePresenceListPage = () => {
    if (window.location.hash === "#lista") fxClose(() => { window.location.hash = ""; });
  };

  // Mesmo esquema, pra página da pelada extra (#lista-extra).
  const [showExtraPresenceListPage, setShowExtraPresenceListPage] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#lista-extra"
  );
  useEffect(() => {
    const onHashChange = () => {
      const isOpen = window.location.hash === "#lista-extra";
      setShowExtraPresenceListPage(isOpen);
      if (isOpen) window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const openExtraPresenceListPage = () => {
    window.location.hash = "lista-extra";
    window.scrollTo(0, 0);
  };
  const closeExtraPresenceListPage = () => {
    if (window.location.hash === "#lista-extra") fxClose(() => { window.location.hash = ""; });
  };

  // Depois de criar a conta, manda a pessoa direto pra home (fecha qualquer
  // página própria aberta e volta pra tela de jogadores) e só então mostra o
  // aviso de "avise um administrador pra vincular".
  const handleSignedUp = () => {
    setScreen("roster");
    closeRulesPage();
    closePresenceListPage();
    closeExtraPresenceListPage();
    setShowSignupLinkAlert(true);
  };

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [numTeams, setNumTeams] = useState(3);
  const [considerGK, setConsiderGK] = useState(true);
  const [method, setMethod] = useState("qualidade");
  const [separateGroups, setSeparateGroups] = useState([
    ["", "", ""],
    ["", "", ""],
  ]);
  const [togetherRules, setTogetherRules] = useState([]);
  const [togetherA, setTogetherA] = useState("");
  const [togetherB, setTogetherB] = useState("");

  const [result, setResult] = useState(null);
  const [genError, setGenError] = useState(null);
  const [toast, setToast] = useState(null);

  // ---- fundo do estádio com parallax ----
  const skyRef = useRef(null);
  const glowRef = useRef(null);
  const logoRef = useRef(null);
  const storyGalleryFileRef = useRef(null);
  const storyPhotoCameraRef = useRef(null);
  const storyVideoCameraRef = useRef(null);
  const [showStorySourceSheet, setShowStorySourceSheet] = useState(false);
  const [showStoryCamera, setShowStoryCamera] = useState(false);
  const pointerRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const onMove = (e) => {
      const p = e.touches ? e.touches[0] : e;
      if (!p) return;
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      pointerRef.current = {
        x: (p.clientX - cx) / cx,
        y: (p.clientY - cy) / cy,
      };
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: true });

    let raf;
    let t = 0;
    const apply = (ref, driftAmp, driftSpeed, pointerFactor, extra = "") => {
      if (!ref.current) return;
      if (!ref.current.closest(".stadium-bg")) return;
      const idleX = Math.sin(t * driftSpeed) * driftAmp;
      const idleY = Math.cos(t * driftSpeed * 0.7) * driftAmp * 0.6;
      const px = pointerRef.current.x * pointerFactor;
      const py = pointerRef.current.y * pointerFactor * 0.6;
      ref.current.style.transform = `translate3d(${idleX + px}px, ${idleY + py}px, 0)${extra}`;
    };
    const loop = () => {
      t += 0.01;
      apply(skyRef, 5, 0.35, 6);
      apply(glowRef, 9, 0.5, 12);
      const rot = Math.sin(t * 0.4) * 3;
      apply(logoRef, 14, 0.3, 16, ` rotate(${rot}deg)`);
      raf = requestAnimationFrame(loop);
    };
    // Pausa a animação quando o app está em segundo plano (economiza bateria
    // no celular) e retoma assim que volta ao primeiro plano.
    const handleVisibility = () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
      } else if (!raf) {
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    raf = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Carrega as peladas "abertas" (a principal e, se existir, a extra) e a
  // lista de presença de cada uma. Pública — qualquer pessoa (logada ou
  // não) pode ver a lista. Pode existir no máximo uma 'main' aberta e uma
  // 'extra' aberta ao mesmo tempo — uma não fecha a outra.
  const loadPeladaAndPresences = async () => {
    const { data: peladaRows } = await supabase
      .from("peladas")
      .select("*")
      .eq("status", "open")
      .order("created_at", { ascending: false });
    const mainRow = (peladaRows || []).find((r) => (r.kind || "main") === "main") || null;
    const extraRow = (peladaRows || []).find((r) => r.kind === "extra") || null;
    setPelada(mainRow ? rowToPelada(mainRow) : null);
    setPeladaExtra(extraRow ? rowToPelada(extraRow) : null);

    const idsToLoad = [mainRow?.id, extraRow?.id].filter(Boolean);
    if (idsToLoad.length > 0) {
      const { data: presenceRows } = await supabase
        .from("presences")
        .select("*")
        .in("pelada_id", idsToLoad);
      setPresences((presenceRows || []).filter((p) => p.pelada_id === mainRow?.id));
      setPresencesExtra((presenceRows || []).filter((p) => p.pelada_id === extraRow?.id));
    } else {
      setPresences([]);
      setPresencesExtra([]);
    }
  };

  // A partir da sessão do Supabase Auth, descobre se quem logou é
  // administrador (tabela "admins") e, se for, carrega os cadastros
  // pendentes de vínculo (tabela "profiles") pra usar no formulário de
  // jogador. Usuário comum não enxerga essa lista (RLS já barra).
  const applySession = async (session) => {
    const user = session?.user ?? null;
    setAuthUser(user);
    if (!user) {
      setIsAdmin(false);
      setProfiles([]);
      return;
    }
    const { data: adminRow } = await supabase
      .from("admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    const admin = !!adminRow;
    setIsAdmin(admin);
    if (admin) {
      const { data: profileRows } = await supabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: true });
      setProfiles(
        (profileRows || []).map((r) => ({ id: r.id, email: r.email, fullName: r.full_name }))
      );
      const { data: adminRows } = await supabase.from("admins").select("user_id");
      setAdminUserIds(new Set((adminRows || []).map((r) => r.user_id)));
    } else {
      setProfiles([]);
      setAdminUserIds(new Set());
    }
  };

  // ---- carregamento inicial: elenco (público) + lista publicada + próxima
  // pelada (presença, pública) + sessão de login ----
  // Busca tudo de novo do zero (elenco, lista publicada, aviso, pelada +
  // presenças e sessão) — usado tanto no carregamento inicial quanto quando
  // a pessoa toca no logo pra "atualizar e voltar pro início".
  const loadEverything = async () => {
    const { data, error } = await supabase
      .from("players")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) {
      setLoadError(true);
    } else {
      setLoadError(false);
      setPlayers(data.map(rowToPlayer));
    }

    const { data: publishedRow } = await supabase
      .from("published_list")
      .select("*")
      .eq("id", PUBLISHED_LIST_ID)
      .maybeSingle();
    setPublishedList(publishedRow ? rowToPublishedList(publishedRow) : null);

    const { data: announcementRow } = await supabase
      .from("announcements")
      .select("*")
      .eq("id", ANNOUNCEMENT_ID)
      .maybeSingle();
    if (announcementRow) {
      const a = rowToAnnouncement(announcementRow);
      setAnnouncement(a);
      if (!isAnnouncementDismissed(a)) setShowAnnouncementPopup(true);
    } else {
      setAnnouncement(null);
    }

    await loadPeladaAndPresences();

    const { data: sessionData } = await supabase.auth.getSession();
    await applySession(sessionData?.session ?? null);
  };

  useEffect(() => {
    (async () => {
      await loadEverything();
      setReady(true);
    })();

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      applySession(session);
      // O Supabase manda esse evento quando a pessoa volta pro site pelo
      // link do e-mail de "esqueci minha senha" — abre a tela de escolher
      // a senha nova em vez de simplesmente logar ela.
      if (event === "PASSWORD_RECOVERY") {
        setShowAccountModal(false);
        setShowSetNewPassword(true);
      }
    });
    return () => authListener?.subscription?.unsubscribe();
  }, []);

  // Tempo real: a lista de presença da pelada aberta atualiza sozinha na
  // tela de todo mundo à medida que as pessoas forem confirmando ou
  // marcando ausência (sem precisar recarregar a página).
  //
  // Isso sozinho não é 100% confiável: o celular suspende o websocket
  // quando o navegador vai pra segundo plano (tela apagada, trocou de
  // app), e ao voltar o Supabase não reenvia os eventos perdidos nesse
  // meio-tempo — por isso, além de reinscrever quando cai, também forçamos
  // uma releitura completa sempre que a aba/app volta a ficar visível ou a
  // conexão volta, e mantemos um "puxão" periódico de segurança por trás.
  useEffect(() => {
    if (!pelada) return;
    let cancelled = false;
    let channel = null;

    const subscribe = () => {
      channel = supabase
        .channel(`presences-${pelada.id}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "presences", filter: `pelada_id=eq.${pelada.id}` },
          (payload) => {
            setPresences((prev) => {
              if (payload.eventType === "DELETE") {
                return prev.filter((p) => p.id !== payload.old.id);
              }
              const row = payload.new;
              return [...prev.filter((p) => p.id !== row.id), row];
            });
          }
        )
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            supabase.removeChannel(channel);
            setTimeout(() => {
              if (!cancelled) subscribe();
            }, 1500);
          }
        });
    };
    subscribe();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [pelada?.id]);

  // Mesma coisa, só que pra pelada extra.
  useEffect(() => {
    if (!peladaExtra) return;
    let cancelled = false;
    let channel = null;

    const subscribe = () => {
      channel = supabase
        .channel(`presences-extra-${peladaExtra.id}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "presences", filter: `pelada_id=eq.${peladaExtra.id}` },
          (payload) => {
            setPresencesExtra((prev) => {
              if (payload.eventType === "DELETE") {
                return prev.filter((p) => p.id !== payload.old.id);
              }
              const row = payload.new;
              return [...prev.filter((p) => p.id !== row.id), row];
            });
          }
        )
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            supabase.removeChannel(channel);
            setTimeout(() => {
              if (!cancelled) subscribe();
            }, 1500);
          }
        });
    };
    subscribe();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [peladaExtra?.id]);

  // Tempo real pra tabela de peladas em si: quando o admin publica, fecha,
  // exclui ou reabre uma lista (principal ou extra), todo mundo que já está
  // com o app aberto vê o banner/lista aparecer ou sumir na hora, sem
  // precisar recarregar a página pra "descobrir" que agora tem lista aberta.
  useEffect(() => {
    const channel = supabase
      .channel("peladas-public")
      .on("postgres_changes", { event: "*", schema: "public", table: "peladas" }, () => {
        loadPeladaAndPresences();
        loadAttendance();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Stories: carrega ao abrir o app e mantém em tempo real (story novo
  // aparece na hora pra todo mundo, sem precisar recarregar).
  useEffect(() => {
    loadStories();
    const channel = supabase
      .channel("stories-public")
      .on("postgres_changes", { event: "*", schema: "public", table: "stories" }, () => {
        loadStories();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Rede de segurança: se o websocket cair silenciosamente (proxy/firewall
  // corporativo, celular que suspendeu a conexão e não avisou, etc.), essas
  // duas coisas garantem que a lista nunca fique "travada" no que a pessoa
  // via antes: (1) sempre que a aba/app volta a ficar em foco ou a internet
  // volta, recarrega tudo na hora; (2) por garantia extra, recarrega sozinho
  // a cada 20s enquanto tiver alguma lista aberta na tela.
  useEffect(() => {
    const onFocusish = () => {
      if (document.visibilityState === "visible") loadPeladaAndPresences();
    };
    document.addEventListener("visibilitychange", onFocusish);
    window.addEventListener("focus", onFocusish);
    window.addEventListener("online", onFocusish);
    return () => {
      document.removeEventListener("visibilitychange", onFocusish);
      window.removeEventListener("focus", onFocusish);
      window.removeEventListener("online", onFocusish);
    };
  }, []);

  useEffect(() => {
    if (!pelada && !peladaExtra) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") loadPeladaAndPresences();
    }, 20000);
    return () => clearInterval(interval);
  }, [!!pelada, !!peladaExtra]);

  // Tempo real pro elenco inteiro: mantém os cards, selos de mensalista e a
  // lista pública de interessados sempre atualizados sozinhos, pra
  // qualquer pessoa olhando (com ou sem login) — sem isso, mudanças feitas
  // por um admin (ou por outro jogador pedindo interesse) só apareciam pra
  // quem estava olhando depois de recarregar a página manualmente.
  useEffect(() => {
    const channel = supabase
      .channel("players-public")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setPlayers((prev) => prev.filter((p) => p.id !== payload.old.id));
            return;
          }
          const updated = rowToPlayer(payload.new);
          setPlayers((prev) =>
            prev.some((p) => p.id === updated.id)
              ? prev.map((p) => (p.id === updated.id ? updated : p))
              : [...prev, updated]
          );
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Tempo real: quando o admin publica (ou remove) um aviso, ele aparece em
  // popup na hora pra quem já está com o app aberto, sem precisar recarregar.
  useEffect(() => {
    const channel = supabase
      .channel("announcements-public")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "announcements", filter: `id=eq.${ANNOUNCEMENT_ID}` },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setAnnouncement(null);
            setShowAnnouncementPopup(false);
            return;
          }
          const a = rowToAnnouncement(payload.new);
          setAnnouncement(a);
          if (!isAnnouncementDismissed(a)) setShowAnnouncementPopup(true);
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Card vinculado à conta atualmente logada (se houver)
  const myPlayer = authUser ? players.find((p) => p.userId === authUser.id) ?? null : null;
  useEffect(() => {
    setSwActor(myPlayer ? displayName(myPlayer) : authUser?.email ? authUser.email.split("@")[0] : "Alguém");
  }, [myPlayer?.id, myPlayer?.nickname, myPlayer?.name, authUser?.email]); // eslint-disable-line react-hooks/exhaustive-deps

  // Assim que um admin vincula o login a um card, quem estiver com o app
  // aberto vê isso chegar em tempo real (canal "players-public" acima) — daí
  // mostra as boas-vindas uma única vez (guardado por jogador, pra não
  // repetir a cada visita).
  useEffect(() => {
    if (!myPlayer) return;
    const storageKey = `pelada4k_welcomed_${myPlayer.id}`;
    try {
      if (localStorage.getItem(storageKey)) return;
      localStorage.setItem(storageKey, "1");
    } catch {
      /* localStorage indisponível — mostra assim mesmo, sem persistir */
    }
    setShowWelcomeModal(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPlayer?.id]);

  // Telefone: admin carrega o de todo mundo (pra mostrar nos cards);
  // usuário comum só carrega o próprio (pra poder editar). RLS garante que
  // ninguém consegue ler o de outra pessoa mesmo tentando pela API direto.
  useEffect(() => {
    (async () => {
      if (isAdmin) {
        const { data } = await supabase.from("player_contacts").select("*");
        const map = {};
        (data || []).forEach((r) => {
          map[r.player_id] = r.phone;
        });
        setContacts(map);
      } else if (myPlayer) {
        const { data } = await supabase
          .from("player_contacts")
          .select("*")
          .eq("player_id", myPlayer.id)
          .maybeSingle();
        setContacts(data ? { [myPlayer.id]: data.phone } : {});
      } else {
        setContacts({});
      }
    })();
  }, [isAdmin, myPlayer?.id]);

  // Badge de sugestões novas no menu do admin (sem precisar abrir a caixa).
  useEffect(() => {
    (async () => {
      if (!isAdmin) {
        setSuggestionsUnreadCount(0);
        return;
      }
      const { data } = await supabase.from("suggestions").select("id").neq("status", "read");
      setSuggestionsUnreadCount((data || []).length);
    })();
  }, [isAdmin]);

  // Configuração global (pública): se o admin ligou o bloqueio de acesso
  // pra mensalista inadimplente. Qualquer um pode ler (precisa pra saber se
  // o próprio acesso está travado), só admin altera.
  useEffect(() => {
    const applySetting = (row) => {
      if (!row) return;
      if (row.key === "block_unpaid_mensalistas") setBlockUnpaidEnabled(!!row.value);
      if (row.key === "pix_settings") setPixSettings(row.value || null);
    };
    (async () => {
      const { data } = await supabase
        .from("app_settings")
        .select("*")
        .in("key", ["block_unpaid_mensalistas", "pix_settings"]);
      (data || []).forEach(applySetting);
    })();
    // Tempo real: quando o admin troca o PIX do mês (ou liga/desliga o
    // bloqueio), quem está com o app aberto recebe na hora.
    const channel = supabase
      .channel("app-settings")
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, (payload) => {
        if (payload.eventType === "DELETE") return;
        applySetting(payload.new);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const savePixSettings = async (next) => {
    const { error } = await supabase.from("app_settings").upsert({ key: "pix_settings", value: next });
    if (!error) {
      setPixSettings(next);
      setToast("PIX do mês atualizado!");
    } else {
      setToast("Não foi possível salvar o PIX.");
    }
  };

  const toggleBlockUnpaid = async () => {
    const next = !blockUnpaidEnabled;
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key: "block_unpaid_mensalistas", value: next });
    if (!error) setBlockUnpaidEnabled(next);
  };

  // Pagamento de mensalidade do mês corrente: admin carrega de todo mundo
  // (pra tela de controle), usuário comum mensalista carrega só o próprio
  // (pra saber se o acesso está liberado).
  useEffect(() => {
    (async () => {
      const month = currentMonthKey();
      if (isAdmin) {
        const { data } = await supabase.from("membership_payments").select("*").eq("month", month);
        const map = {};
        (data || []).forEach((r) => {
          map[r.player_id] = { paid: r.paid, paidAt: r.paid_at };
        });
        setMembershipPayments(map);
      } else if (myPlayer) {
        const { data } = await supabase
          .from("membership_payments")
          .select("*")
          .eq("player_id", myPlayer.id)
          .eq("month", month)
          .maybeSingle();
        setMembershipPayments(data ? { [myPlayer.id]: { paid: data.paid, paidAt: data.paid_at } } : {});
      } else {
        setMembershipPayments({});
      }
    })();
  }, [isAdmin, myPlayer?.id]);

  // Caixa que recebe um pagamento marcado agora: o admin dono do PIX do mês
  // (quem de fato recebeu o dinheiro). Sem dono definido no PIX, cai no
  // caixa de quem marcou o check.
  const receivingCaixaId = () => activePix.id || PIX_INFO.id;

  // Admin: marca/desmarca a mensalidade do mês corrente de um mensalista como paga
  const setMensalistaPaid = async (playerId, paid) => {
    const month = currentMonthKey();
    const { data, error } = await supabase
      .from("membership_payments")
      .upsert(
        {
          player_id: playerId,
          month,
          paid,
          paid_at: paid ? new Date().toISOString() : null,
          updated_by: authUser?.id,
          caixa_id: paid ? receivingCaixaId() : null,
        },
        { onConflict: "player_id,month" }
      )
      .select()
      .single();
    if (!error) {
      setMembershipPayments((prev) => ({ ...prev, [playerId]: { paid: data.paid, paidAt: data.paid_at } }));
    }
  };

  // Admin: marca/desmarca o pagamento de uma presença de avulso (por pelada)
  const setPresencePaid = async (presenceId, paid) => {
    const { data, error } = await supabase
      .from("presences")
      .update({
        paid,
        paid_by: paid ? authUser?.id ?? null : null,
        paid_at: paid ? new Date().toISOString() : null,
        caixa_id: paid ? receivingCaixaId() : null,
      })
      .eq("id", presenceId)
      .select()
      .single();
    if (!error) setPresences((prev) => prev.map((p) => (p.id === presenceId ? data : p)));
  };

  // Admin: sobe um avulso da fila de espera direto pra lista principal
  // (CONFIRMADOS) a qualquer momento, mesmo sem vaga aberta por ausência de
  // mensalista. "demote" desfaz, devolvendo pra fila de espera normal.
  const promoteAvulso = async (presenceId) => {
    const { data, error } = await supabase
      .from("presences")
      .update({ manually_promoted: true })
      .eq("id", presenceId)
      .select()
      .single();
    if (!error) setPresences((prev) => prev.map((p) => (p.id === presenceId ? data : p)));
  };
  const demoteAvulso = async (presenceId) => {
    const { data, error } = await supabase
      .from("presences")
      .update({ manually_promoted: false })
      .eq("id", presenceId)
      .select()
      .single();
    if (!error) setPresences((prev) => prev.map((p) => (p.id === presenceId ? data : p)));
  };

  const myPresence = myPlayer ? presences.find((pr) => pr.player_id === myPlayer.id) ?? null : null;
  const amIConfirmed = myPresence?.status === "confirmed";
  const amIAbsent = myPresence?.status === "absent";

  // Usuário comum marca a própria presença/ausência (upsert — uma resposta
  // por pelada). Clicar de novo no estado já ativo limpa a resposta.
  const setMyPresenceStatus = async (status) => {
    if (!myPlayer || !pelada) return;
    if (myAccessBlocked) return;
    const current = presences.find((pr) => pr.player_id === myPlayer.id);
    if (current?.status === status) {
      const { error } = await supabase.from("presences").delete().eq("id", current.id);
      if (!error) setPresences((prev) => prev.filter((p) => p.id !== current.id));
      return;
    }
    // Mensalista (fora goleiro) que confirma depois de segunda 12h — seja
    // porque retirou uma ausência antes, seja porque nunca tinha respondido
    // — já pode ter tido a vaga preenchida por um avulso, então entra no fim
    // da fila de avulsos em vez de recuperar a vaga garantida de mensalista.
    // Antes das 12h é o fluxo normal: a conta de ausentes cai e o avulso
    // promovido (se algum chegou a subir) volta pra fila sozinho.
    const isLateMensalistaReturn =
      status === "confirmed" && isMensalista(myPlayer) && !myPlayer.isGK && isAfterMonday12hBRT();
    const { data, error } = await supabase
      .from("presences")
      .upsert(
        {
          pelada_id: pelada.id,
          player_id: myPlayer.id,
          status,
          confirmed_by: authUser?.id,
          late_rejoin: isLateMensalistaReturn,
          auto_absent: false,
        },
        { onConflict: "pelada_id,player_id" }
      )
      .select()
      .single();
    if (error) {
      setToast("Não foi possível salvar sua resposta. Tente novamente.");
    } else {
      setPresences((prev) => [...prev.filter((p) => p.player_id !== myPlayer.id), data]);
      if (status === "confirmed" && !isMensalista(myPlayer)) {
        setPaymentAlert("avulso_waiting");
      } else if (isLateMensalistaReturn) {
        setPaymentAlert("late_rejoin");
      } else if (status === "confirmed" && myMensalidadePending && isFirstPeladaOfMonth(pelada)) {
        // Primeira pelada do mês: lembra a mensalidade (com JÁ PAGUEI) até
        // ele avisar que pagou ou um admin confirmar o pagamento.
        setPaymentAlert("mensalista_primeira");
      }
    }
  };

  // Usuário comum (avulso) manifesta interesse em virar mensalista — grava
  // só a data do pedido; quem decide vira mensalista é o admin.
  const expressMembershipInterest = async () => {
    if (!myPlayer) return;
    const { data, error } = await supabase
      .from("players")
      .update({ membership_interest_at: new Date().toISOString() })
      .eq("id", myPlayer.id)
      .select()
      .single();
    if (!error) {
      setPlayers((prev) => prev.map((p) => (p.id === myPlayer.id ? rowToPlayer(data) : p)));
      setToast("Pedido enviado! Um administrador vai avaliar.");
    }
  };

  // Admin: aprova (vira mensalista) ou recusa (limpa o pedido) um interessado
  const setPlayerMembership = async (playerId, membershipType) => {
    const { data, error } = await supabase
      .from("players")
      .update({ membership_type: membershipType, membership_interest_at: null, temp_replaces_player_id: null })
      .eq("id", playerId)
      .select()
      .single();
    if (!error) {
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id === playerId) return rowToPlayer(data);
          // Mensalista original voltou: quem estava no lugar dele volta pra
          // lista de interessados (o banco faz isso sozinho; aqui só reflete
          // na tela na hora, sem esperar o tempo real).
          if (membershipType === "mensalista" && p.tempReplacesPlayerId === playerId) {
            return { ...p, membershipType: "avulso", tempReplacesPlayerId: null };
          }
          return p;
        })
      );
    }
  };

  // ---- Mensalista temporário ----
  const replacedNameFor = (p) => {
    const original = players.find((pl) => pl.id === p.tempReplacesPlayerId);
    return original ? displayName(original) : "mensalista removido";
  };
  // Na lista de presença, só o admin vê no lugar de quem o temporário entrou.
  const tempSubtitle = (p, base) =>
    isAdmin && isTempMensalista(p)
      ? [base, `NO LUGAR DE ${replacedNameFor(p).toUpperCase()}`].filter(Boolean).join(" · ")
      : base;
  const applyPlayerRows = (rows) => {
    const byId = new Map(rows.filter(Boolean).map((r) => [r.id, rowToPlayer(r)]));
    setPlayers((prev) => prev.map((p) => byId.get(p.id) ?? p));
  };

  // Interessado entra no lugar de um mensalista: o mensalista vira avulso, o
  // interessado vira mensalista guardando de quem é a vaga. A data/posição
  // dele na fila de interessados fica guardada pra quando ele voltar.
  const makeTempMensalista = async (interestedId, mensalistaId) => {
    const resOriginal = await supabase
      .from("players")
      .update({ membership_type: "avulso" })
      .eq("id", mensalistaId)
      .select()
      .single();
    if (resOriginal.error) {
      setToast("Não foi possível fazer a troca.");
      return;
    }
    const resTemp = await supabase
      .from("players")
      .update({
        membership_type: "mensalista",
        temp_replaces_player_id: mensalistaId,
        temp_started_at: new Date().toISOString(),
      })
      .eq("id", interestedId)
      .select()
      .single();
    if (resTemp.error) {
      // Desfaz a primeira metade pra não deixar o mensalista sem vaga à toa.
      await supabase.from("players").update({ membership_type: "mensalista" }).eq("id", mensalistaId);
      setToast("Não foi possível fazer a troca.");
      return;
    }
    applyPlayerRows([resOriginal.data, resTemp.data]);
    setToast("Mensalista temporário definido!");
  };

  // Mensalista original voltou: ele volta a ser mensalista e o temporário
  // volta pra lista de interessados, na mesma posição de antes.
  const restoreOriginalMensalista = async (tempPlayer) => {
    const originalId = tempPlayer.tempReplacesPlayerId;
    const resTemp = await supabase
      .from("players")
      .update({ membership_type: "avulso", temp_replaces_player_id: null })
      .eq("id", tempPlayer.id)
      .select()
      .single();
    if (resTemp.error) return;
    const rows = [resTemp.data];
    if (originalId && players.some((p) => p.id === originalId)) {
      const resOriginal = await supabase
        .from("players")
        .update({ membership_type: "mensalista", membership_interest_at: null })
        .eq("id", originalId)
        .select()
        .single();
      if (!resOriginal.error) rows.push(resOriginal.data);
    }
    applyPlayerRows(rows);
  };

  // Encerra o temporário sem o original voltar: o temporário volta pra lista
  // de interessados (mesma posição) e o original continua avulso.
  const endTempMensalista = async (tempId) => {
    const { data, error } = await supabase
      .from("players")
      .update({ membership_type: "avulso", temp_replaces_player_id: null })
      .eq("id", tempId)
      .select()
      .single();
    if (!error) applyPlayerRows([data]);
  };

  // "Tornar avulso" definitivo: o mensalista vira avulso e o interessado
  // escolhido sobe como mensalista fixo (sai da fila de interessados).
  const replaceMensalista = async (mensalistaId, interestedId) => {
    await setPlayerMembership(mensalistaId, "avulso");
    await setPlayerMembership(interestedId, "mensalista");
    setToast("Troca de mensalista feita!");
  };

  // Efetiva o temporário: vira mensalista fixo e sai da fila de interessados.
  const makeTempPermanent = async (tempId) => {
    await setPlayerMembership(tempId, "mensalista");
  };
  const dismissMembershipInterest = async (playerId) => {
    const { data, error } = await supabase
      .from("players")
      .update({ membership_interest_at: null })
      .eq("id", playerId)
      .select()
      .single();
    if (!error) setPlayers((prev) => prev.map((p) => (p.id === playerId ? rowToPlayer(data) : p)));
  };

  // Admin: inclui qualquer jogador na lista de interessados diretamente
  // (sem precisar que a própria pessoa peça) — a lista de interessados é de
  // livre alteração do admin.
  // Aceita vários de uma vez (caixa de seleção) — inclui um por vez, na
  // ordem marcada, pra cada um ganhar sua posição no fim da fila.
  const adminMarkInterest = async (playerIds) => {
    const ids = Array.isArray(playerIds) ? playerIds : [playerIds];
    const rows = [];
    for (const id of ids) {
      const { data, error } = await supabase
        .from("players")
        .update({
          membership_interest_at: new Date().toISOString(),
          membership_interest_by: authUser?.id ?? null,
        })
        .eq("id", id)
        .select()
        .single();
      if (!error) rows.push(data);
    }
    if (rows.length > 0) {
      const byId = new Map(rows.map((r) => [r.id, rowToPlayer(r)]));
      setPlayers((prev) => prev.map((p) => byId.get(p.id) ?? p));
    }
    if (rows.length === ids.length) {
      setToast(
        ids.length === 1
          ? `${displayName(rowToPlayer(rows[0]))} incluído na lista de interessados!`
          : `${ids.length} membros incluídos na lista de interessados!`
      );
    } else {
      setToast("Não foi possível incluir todos na lista.");
    }
  };

  // Nome do admin que incluiu alguém na lista de interessados (só admin vê)
  const interestAddedByName = (p) => (p.membershipInterestBy ? adminActionName(p.membershipInterestBy) : null);

  // Fila de interessados como é exibida: quem está esperando + quem está
  // ativo como mensalista temporário (continua ocupando o lugar dele na
  // fila, com o nome de quem ele substitui e o mês da troca).
  const byInterestOrder = (a, b) => {
    const orderA = a.membershipInterestOrder ?? Infinity;
    const orderB = b.membershipInterestOrder ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;
    return new Date(a.membershipInterestAt) - new Date(b.membershipInterestAt);
  };
  const interestQueue = players
    .filter((p) => p.membershipInterestAt && (!isMensalista(p) || isTempMensalista(p)))
    .sort(byInterestOrder);
  // Só quem está de fato esperando (pode subir pra mensalista) — usado na
  // escolha de quem sobe e no contador do menu.
  const membershipInterestList = interestQueue.filter((p) => !isMensalista(p));
  // "(Fulano · Outubro/2026)" — no lugar de quem e desde quando
  const tempInterestInfo = (p) =>
    isTempMensalista(p)
      ? {
          replacedName: replacedNameFor(p),
          month: p.tempStartedAt ? monthKeyLabel(currentMonthKey(new Date(p.tempStartedAt))) : null,
        }
      : null;
  // Jogadores que o admin ainda pode incluir na lista de interesse "na mão"
  const interestAvailableToAdd = players.filter((p) => !isMensalista(p) && !p.membershipInterestAt);

  // Admin: reordena a fila de interessados — troca a posição de um item
  // com o vizinho de cima/baixo, na ordem atual da lista.
  const reorderMembershipInterest = async (playerId, direction) => {
    const idx = interestQueue.findIndex((p) => p.id === playerId);
    if (idx === -1) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= interestQueue.length) return;
    const a = interestQueue[idx];
    const b = interestQueue[swapIdx];
    const aOrder = a.membershipInterestOrder ?? idx + 1;
    const bOrder = b.membershipInterestOrder ?? swapIdx + 1;
    const [resA, resB] = await Promise.all([
      supabase.from("players").update({ membership_interest_order: bOrder }).eq("id", a.id).select().single(),
      supabase.from("players").update({ membership_interest_order: aOrder }).eq("id", b.id).select().single(),
    ]);
    if (!resA.error && !resB.error) {
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id === resA.data.id) return rowToPlayer(resA.data);
          if (p.id === resB.data.id) return rowToPlayer(resB.data);
          return p;
        })
      );
    }
  };

  // Lista de mensalistas pra tela de controle de pagamento
  const mensalistaList = players.filter(isMensalista).sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const nonMensalistaPlayers = players
    .filter((p) => !isMensalista(p))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  // Goleiros são mensalistas mas não pagam a pelada — não entram no
  // controle de pagamento (não tem cobrança pra eles) e ficam sempre
  // liberados no acesso à lista, mesmo com o bloqueio de inadimplentes
  // ligado.
  const payableMensalistaList = mensalistaList.filter((p) => !p.isGK);

  // Se o admin ligou o bloqueio e o próprio jogador (mensalista, não
  // goleiro) está com a mensalidade do mês em aberto, ele não consegue
  // confirmar presença — vê um aviso pra pagar em vez dos botões.
  const myMembershipPaid = myPlayer ? !!membershipPayments[myPlayer.id]?.paid : false;
  // A escalação salva é da pelada aberta agora? Ela fica no banco até o
  // admin publicar outra — sem essa checagem, a escalação da semana passada
  // escondia o banner "LISTA ABERTA" da lista nova de sexta-feira.
  const escalacaoIsCurrent =
    !!publishedList &&
    (!pelada ||
      !publishedList.updatedAt ||
      !pelada.createdAt ||
      new Date(publishedList.updatedAt) >= new Date(pelada.createdAt));
  // Mensalista (ou temporário) que paga mensalidade — goleiro não paga.
  const myMensalidadeDue = !!myPlayer && isMensalista(myPlayer) && !myPlayer.isGK;
  // O próprio jogador já avisou "JÁ PAGUEI" neste mês
  const myReportedPaid = !!myPlayer && myPlayer.membershipReportedMonth === currentMonthKey();
  // Ainda faz sentido cobrar: deve, admin não confirmou e ele não avisou
  const myMensalidadePending = myMensalidadeDue && !myMembershipPaid && !myReportedPaid;
  const reportMembershipPaid = async () => {
    if (!myPlayer) return;
    const month = currentMonthKey();
    const { data, error } = await supabase
      .from("players")
      .update({ membership_reported_month: month })
      .eq("id", myPlayer.id)
      .select()
      .single();
    setPaymentAlert(null);
    if (!error) {
      setPlayers((prev) => prev.map((p) => (p.id === myPlayer.id ? rowToPlayer(data) : p)));
      setToast("Obrigado! Envie o comprovante pra um administrador confirmar.");
    } else {
      setToast("Não foi possível registrar. Tente novamente.");
    }
  };
  // Pop-ups de mensalidade mostram o JÁ PAGUEI pra quem ainda deve
  const paymentAlertAlreadyPaid =
    (paymentAlert === "mensalista" ||
      paymentAlert === "mensalista_primeira" ||
      paymentAlert === "mensalista_alerta") &&
    myMensalidadeDue &&
    !myMembershipPaid
      ? reportMembershipPaid
      : undefined;
  const myAccessBlocked =
    !!myPlayer && isMensalista(myPlayer) && !myPlayer.isGK && blockUnpaidEnabled && !myMembershipPaid;

  // ---- ENVIAR ALERTA (admin → jogador) ----
  // Admin grava uma linha em payment_alerts; o jogador recebe o pop-up na
  // hora (tempo real) ou ao abrir o app, e a linha é marcada como vista.
  const sendPaymentAlert = async (player, kind) => {
    if (!player) return;
    if (!player.userId) {
      setToast(`${displayName(player)} ainda não tem conta vinculada — não dá pra enviar o alerta pelo app.`);
      return;
    }
    const { error } = await supabase
      .from("payment_alerts")
      .insert({ player_id: player.id, kind, sent_by: authUser?.id });
    setToast(error ? "Não foi possível enviar o alerta." : `Alerta enviado para ${displayName(player)}!`);
  };
  const showIncomingPaymentAlert = (row) => {
    if (!row || row.seen_at) return;
    supabase.from("payment_alerts").update({ seen_at: new Date().toISOString() }).eq("id", row.id).then(() => {});
    setPaymentAlert(row.kind === "mensalista" ? "mensalista_alerta" : "avulso_alerta");
  };
  const myPlayerIdForAlerts = myPlayer?.id;
  useEffect(() => {
    if (!myPlayerIdForAlerts) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("payment_alerts")
        .select("*")
        .eq("player_id", myPlayerIdForAlerts)
        .is("seen_at", null)
        .order("created_at", { ascending: false });
      if (cancelled || !data || data.length === 0) return;
      // Marca todos como vistos; mostra só o mais recente.
      supabase
        .from("payment_alerts")
        .update({ seen_at: new Date().toISOString() })
        .eq("player_id", myPlayerIdForAlerts)
        .is("seen_at", null)
        .then(() => {});
      setPaymentAlert(data[0].kind === "mensalista" ? "mensalista_alerta" : "avulso_alerta");
    })();
    const channel = supabase
      .channel(`payment-alerts-${myPlayerIdForAlerts}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "payment_alerts", filter: `player_id=eq.${myPlayerIdForAlerts}` },
        (payload) => showIncomingPaymentAlert(payload.new)
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPlayerIdForAlerts]);
  // Mensalista com a mensalidade do mês em aberto / avulso promovido que
  // ainda não pagou — é pra eles que o admin vê o botão ENVIAR ALERTA.
  const alertButton = (player, kind) =>
    isAdmin ? (
      <button type="button" className="mens-btn mens-btn-danger send-alert-btn" onClick={() => sendPaymentAlert(player, kind)}>
        <Emo e="🔔" /> ENVIAR ALERTA
      </button>
    ) : null;

  // Todo dia 1º, mensalista vê o aviso de pagamento da mensalidade (uma vez
  // por mês por navegador — não incomoda de novo até o mês seguinte).
  useEffect(() => {
    if (!myPlayer || !isMensalista(myPlayer) || myPlayer.isGK) return;
    // Já pago (confirmado pelo admin) ou já avisou "JÁ PAGUEI" → não cobra
    if (myMembershipPaid || myReportedPaid) return;
    const today = new Date();
    if (today.getDate() !== 1) return;
    const monthKey = `${today.getFullYear()}-${today.getMonth() + 1}`;
    const storageKey = `pelada4k_mensalidade_${myPlayer.id}_${monthKey}`;
    try {
      if (localStorage.getItem(storageKey)) return;
      localStorage.setItem(storageKey, "1");
    } catch {
      /* localStorage indisponível — mostra assim mesmo, sem persistir */
    }
    setPaymentAlert("mensalista");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPlayer?.id, myMembershipPaid, myReportedPaid]);

  // Admin: marca/remove presença ou ausência de qualquer jogador do elenco
  const adminSetPlayerPresence = async (playerId, status) => {
    if (!pelada) return;
    if (status === null) {
      const { error } = await supabase
        .from("presences")
        .delete()
        .eq("pelada_id", pelada.id)
        .eq("player_id", playerId);
      if (!error) setPresences((prev) => prev.filter((p) => p.player_id !== playerId));
      return;
    }
    const { data, error } = await supabase
      .from("presences")
      .upsert(
        { pelada_id: pelada.id, player_id: playerId, status, confirmed_by: authUser?.id },
        { onConflict: "pelada_id,player_id" }
      )
      .select()
      .single();
    if (!error) setPresences((prev) => [...prev.filter((p) => p.player_id !== playerId), data]);
  };

  // Admin: inclui/remove um AVULSO (alguém de fora do elenco cadastrado)
  const adminAddGuest = async (guestName) => {
    if (!pelada || !guestName.trim()) return;
    const { data, error } = await supabase
      .from("presences")
      .insert({
        pelada_id: pelada.id,
        guest_name: formatFullNameValue(guestName),
        status: "confirmed",
        confirmed_by: authUser?.id,
      })
      .select()
      .single();
    if (!error) setPresences((prev) => [...prev, data]);
  };
  const adminRemoveGuest = async (presenceId) => {
    const { error } = await supabase.from("presences").delete().eq("id", presenceId);
    if (!error) setPresences((prev) => prev.filter((p) => p.id !== presenceId));
  };

  // Admin: publica uma nova pelada. kind="main" fecha só a principal
  // anterior (se houver) e abre a nova como principal; kind="extra" fecha só
  // a extra anterior (se houver) — as duas linhas nunca se cruzam, então
  // publicar uma extra não mexe na principal em andamento, e vice-versa.
  const publishPelada = async ({ scheduledFor, location, kind = "main" }) => {
    const current = kind === "extra" ? peladaExtra : pelada;
    if (current) {
      await supabase.from("peladas").update({ status: "closed" }).eq("id", current.id);
    }
    const { data, error } = await supabase
      .from("peladas")
      .insert({
        scheduled_for: scheduledFor || null,
        location: location || null,
        status: "open",
        kind,
        created_by: authUser?.id,
      })
      .select()
      .single();
    if (error) {
      setToast(kind === "extra" ? "Não foi possível publicar a pelada extra." : "Não foi possível publicar a nova pelada.");
    } else if (kind === "extra") {
      setPeladaExtra(rowToPelada(data));
      setPresencesExtra([]);
      setShowPublishPeladaExtra(false);
      setToast("Pelada extra publicada!");
    } else {
      setPelada(rowToPelada(data));
      setPresences([]);
      setShowPublishPelada(false);
      setToast("Nova pelada publicada!");
    }
  };

  // Admin: "exclui" a lista de presença — não apaga mais de vez, só marca
  // como 'deleted' (some da tela, mas fica guardada e dá pra reabrir depois
  // em Histórico). Serve pra corrigir uma pelada publicada errada ou
  // cancelada sem perder os dados se for engano.
  const deletePelada = async (kind = "main") => {
    const current = kind === "extra" ? peladaExtra : pelada;
    if (!current) return;
    const { error } = await supabase.from("peladas").update({ status: "deleted" }).eq("id", current.id);
    if (error) {
      setToast("Não foi possível excluir a lista. Confirme se você está logado como administrador.");
    } else if (kind === "extra") {
      setPeladaExtra(null);
      setPresencesExtra([]);
      setToast("Pelada extra excluída — dá pra reabrir em Histórico.");
    } else {
      setPelada(null);
      setPresences([]);
      setToast("Lista de presença excluída — dá pra reabrir em Histórico.");
    }
  };

  // Admin: reabre uma pelada fechada ou excluída (a partir do Histórico).
  // Só pode ter uma 'main' aberta e uma 'extra' aberta por vez, então antes
  // de reabrir fecha a que já estiver aberta do mesmo tipo, se houver.
  const reopenPelada = async (row) => {
    const kind = row.kind || "main";
    await supabase.from("peladas").update({ status: "closed" }).eq("status", "open").eq("kind", kind);
    const { error } = await supabase.from("peladas").update({ status: "open" }).eq("id", row.id);
    if (error) {
      setToast("Não foi possível reabrir a lista.");
    } else {
      setToast("Lista reaberta!");
      setShowHistory(false);
      await loadPeladaAndPresences();
    }
  };

  // Presença (linha da tabela "presences") de cada jogador cadastrado, pra
  // dar pra ver quem marcou — usado só pra decidir se mostra "por fora" (um
  // admin marcou no lugar da pessoa) na lista, e só pro admin ver.
  const presenceByPlayerId = new Map(presences.filter((pr) => pr.player_id).map((pr) => [pr.player_id, pr]));
  const presenceByPlayerIdExtra = new Map(
    presencesExtra.filter((pr) => pr.player_id).map((pr) => [pr.player_id, pr])
  );
  // Quem já está confirmado nessa pelada — usado pra não deixar o admin
  // incluir de novo quem já está na lista (quem só marcou ausência
  // continua selecionável, pra dar pra virar confirmado).
  const presentPlayerIds = new Set(
    presences.filter((pr) => pr.player_id && pr.status === "confirmed").map((pr) => pr.player_id)
  );
  const presentPlayerIdsExtra = new Set(
    presencesExtra.filter((pr) => pr.player_id && pr.status === "confirmed").map((pr) => pr.player_id)
  );
  // Nome de quem confirmou/marcou ausência (id do auth.users em
  // "confirmed_by") — prioriza o nome do card vinculado, senão o perfil.
  const adminActionName = (userId) => {
    if (!userId) return null;
    const linkedPlayer = players.find((p) => p.userId === userId);
    if (linkedPlayer) return displayName(linkedPlayer);
    const profile = profiles.find((pr) => pr.id === userId);
    if (profile) return profile.fullName || profile.email;
    return null;
  };
  // Mostra "por fora" (marcado por um admin) quando quem confirmou não é a
  // própria pessoa — avulso externo (sem card) sempre foi um admin quem
  // incluiu, então mostra sempre que tiver confirmed_by.
  const presenceMarkedByAdmin = (presence, player) => {
    if (!presence || !presence.confirmed_by) return null;
    if (player && player.userId && presence.confirmed_by === player.userId) return null;
    return adminActionName(presence.confirmed_by);
  };

  // Categorias da lista de presença, no formato "LISTA PRESENÇA":
  // confirmados (com goleiros em destaque), avulsos e ausentes. Mensalistas
  // confirmados entram em CONFIRMADOS; jogadores avulsos (mesmo já
  // cadastrados no elenco) entram em AVULSOS junto com os avulsos externos.
  // Mensalista que "retirou ausência" depois do corte de segunda 12h entra
  // como se fosse avulso (presence.late_rejoin) — perdeu a prioridade de
  // mensalista porque a vaga dela já tinha sido ocupada; por isso conta
  // pros avulsos, não pros confirmados oficiais, até a próxima pelada.
  const confirmedPlayers = presences
    .filter((pr) => pr.status === "confirmed" && pr.player_id && !pr.late_rejoin)
    .map((pr) => players.find((p) => p.id === pr.player_id))
    .filter(Boolean);
  const confirmedMensalistas = confirmedPlayers.filter((p) => isMensalista(p));
  const confirmedGKs = confirmedMensalistas.filter((p) => p.isGK);
  const confirmedNonGKs = confirmedMensalistas.filter((p) => !p.isGK);
  const guestPresences = presences.filter((pr) => pr.guest_name);
  // Avulsos da pelada aberta (cadastrados que confirmaram + avulsos
  // externos + mensalistas que retornaram tarde demais) — cada entrada
  // carrega a linha de "presences" junto, pra dar pra controlar o
  // pagamento avulso por pelada.
  const avulsoEntries = presences
    .filter((pr) => pr.status === "confirmed" && pr.guest_name)
    .map((pr) => ({ kind: "guest", presence: pr }))
    .concat(
      presences
        .filter((pr) => pr.status === "confirmed" && pr.player_id)
        .map((pr) => ({ presence: pr, player: players.find((p) => p.id === pr.player_id) }))
        .filter((e) => e.player && (!isMensalista(e.player) || e.presence.late_rejoin))
        .map((e) => ({ kind: "player", presence: e.presence, player: e.player }))
    );
  const absentPlayers = presences
    .filter((pr) => pr.status === "absent" && pr.player_id)
    .map((pr) => players.find((p) => p.id === pr.player_id))
    .filter(Boolean);

  // "Fila de espera": avulso só sobe pra lista oficial (CONFIRMADOS) quando
  // algum mensalista (fora goleiro, que não tem substituto avulso) marca
  // ausência — sobe um avulso por vez, do que está esperando há mais tempo.
  // Quem sobe aparece marcado "(avulso)" e é o único avulso que efetivamente
  // precisa pagar.
  // A ordem é a posição manual (queue_order) quando o admin já mexeu nela;
  // do contrário cai pra ordem de confirmação (created_at), igual antes.
  const avulsoEntriesByAge = [...avulsoEntries].sort((a, b) => {
    const orderA = a.presence.queue_order ?? Infinity;
    const orderB = b.presence.queue_order ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;
    return new Date(a.presence.created_at) - new Date(b.presence.created_at);
  });
  // Além da promoção automática por vaga (ausência de mensalista), o admin
  // pode subir manualmente um avulso pra lista principal a qualquer momento
  // (presence.manually_promoted) — esses entram em CONFIRMADOS sempre,
  // independente de ter vaga aberta ou não.
  const manuallyPromotedEntries = avulsoEntriesByAge.filter((e) => e.presence.manually_promoted);
  const autoQueueEntries = avulsoEntriesByAge.filter((e) => !e.presence.manually_promoted);
  const absentNonGKMensalistas = absentPlayers.filter((p) => isMensalista(p) && !p.isGK);
  const autoPromotedCount = Math.min(absentNonGKMensalistas.length, autoQueueEntries.length);
  const autoPromotedEntries = autoQueueEntries.slice(0, autoPromotedCount);
  // Das vagas abertas, as primeiras são das ausências que o próprio
  // mensalista marcou; as que sobram vieram do fechamento automático de
  // segunda 13h — os avulsos que ocupam essas ganham o selo "PRESENÇA
  // AUTOMÁTICA PELO SISTEMA".
  const userMarkedAbsentCount = absentNonGKMensalistas.filter(
    (p) => !presences.find((pr) => pr.player_id === p.id)?.auto_absent
  ).length;
  const systemPromotedPresenceIds = new Set(
    autoPromotedEntries.slice(userMarkedAbsentCount).map((e) => e.presence.id)
  );
  const promotedAvulsoEntries = [...manuallyPromotedEntries, ...autoPromotedEntries];
  const waitingAvulsoEntries = autoQueueEntries.slice(autoPromotedCount);

  // ---- Pelada extra: tudo "livre" (sem mensalista/fila/pagamento) ----
  // Quem confirma vira confirmado na hora, sem passar por fila de espera —
  // não existe distinção de mensalista numa lista avulsa.
  const confirmedExtraPlayers = presencesExtra
    .filter((pr) => pr.status === "confirmed" && pr.player_id)
    .map((pr) => players.find((p) => p.id === pr.player_id))
    .filter(Boolean);
  const confirmedExtraGKs = confirmedExtraPlayers.filter((p) => p.isGK);
  const confirmedExtraNonGKs = confirmedExtraPlayers.filter((p) => !p.isGK);
  const confirmedExtraGuests = presencesExtra.filter((pr) => pr.status === "confirmed" && pr.guest_name);
  const absentExtraPlayers = presencesExtra
    .filter((pr) => pr.status === "absent" && pr.player_id)
    .map((pr) => players.find((p) => p.id === pr.player_id))
    .filter(Boolean);

  const myPresenceExtra = myPlayer ? presencesExtra.find((pr) => pr.player_id === myPlayer.id) ?? null : null;
  const amIConfirmedExtra = myPresenceExtra?.status === "confirmed";
  const amIAbsentExtra = myPresenceExtra?.status === "absent";

  // Usuário comum confirma/marca ausência na pelada extra — livre, sem
  // bloqueio de mensalidade nem lógica de fila (upsert simples, clicar de
  // novo no mesmo estado limpa a resposta).
  const setMyExtraPresenceStatus = async (status) => {
    if (!myPlayer || !peladaExtra) return;
    const current = presencesExtra.find((pr) => pr.player_id === myPlayer.id);
    if (current?.status === status) {
      const { error } = await supabase.from("presences").delete().eq("id", current.id);
      if (!error) setPresencesExtra((prev) => prev.filter((p) => p.id !== current.id));
      return;
    }
    const { data, error } = await supabase
      .from("presences")
      .upsert(
        { pelada_id: peladaExtra.id, player_id: myPlayer.id, status, confirmed_by: authUser?.id },
        { onConflict: "pelada_id,player_id" }
      )
      .select()
      .single();
    if (error) {
      setToast("Não foi possível salvar sua resposta. Tente novamente.");
    } else {
      setPresencesExtra((prev) => [...prev.filter((p) => p.player_id !== myPlayer.id), data]);
    }
  };

  // Admin: marca/remove presença ou ausência de qualquer jogador na extra —
  // qualquer um do elenco, não só mensalista (lista livre).
  const adminSetExtraPlayerPresence = async (playerId, status) => {
    if (!peladaExtra) return;
    if (status === null) {
      const { error } = await supabase
        .from("presences")
        .delete()
        .eq("pelada_id", peladaExtra.id)
        .eq("player_id", playerId);
      if (!error) setPresencesExtra((prev) => prev.filter((p) => p.player_id !== playerId));
      return;
    }
    const { data, error } = await supabase
      .from("presences")
      .upsert(
        { pelada_id: peladaExtra.id, player_id: playerId, status, confirmed_by: authUser?.id },
        { onConflict: "pelada_id,player_id" }
      )
      .select()
      .single();
    if (!error) setPresencesExtra((prev) => [...prev.filter((p) => p.player_id !== playerId), data]);
  };
  const adminAddGuestExtra = async (guestName) => {
    if (!peladaExtra || !guestName.trim()) return;
    const { data, error } = await supabase
      .from("presences")
      .insert({
        pelada_id: peladaExtra.id,
        guest_name: formatFullNameValue(guestName),
        status: "confirmed",
        confirmed_by: authUser?.id,
      })
      .select()
      .single();
    if (!error) setPresencesExtra((prev) => [...prev, data]);
  };
  const adminRemoveGuestExtra = async (presenceId) => {
    const { error } = await supabase.from("presences").delete().eq("id", presenceId);
    if (!error) setPresencesExtra((prev) => prev.filter((p) => p.id !== presenceId));
  };

  // Admin: reordena a fila de espera dos avulsos — troca a posição de um
  // item com o vizinho de cima/baixo, só dentro de quem ainda está
  // esperando vaga (não mexe em quem já foi promovido).
  const reorderAvulsoQueue = async (presenceId, direction) => {
    const idx = waitingAvulsoEntries.findIndex((e) => e.presence.id === presenceId);
    if (idx === -1) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= waitingAvulsoEntries.length) return;
    const a = waitingAvulsoEntries[idx];
    const b = waitingAvulsoEntries[swapIdx];
    const aOrder = a.presence.queue_order ?? idx + 1;
    const bOrder = b.presence.queue_order ?? swapIdx + 1;
    const [resA, resB] = await Promise.all([
      supabase.from("presences").update({ queue_order: bOrder }).eq("id", a.presence.id).select().single(),
      supabase.from("presences").update({ queue_order: aOrder }).eq("id", b.presence.id).select().single(),
    ]);
    if (!resA.error && !resB.error) {
      setPresences((prev) =>
        prev.map((p) => {
          if (p.id === resA.data.id) return resA.data;
          if (p.id === resB.data.id) return resB.data;
          return p;
        })
      );
    }
  };

  const presenceShareText = () => {
    const lines = ["LISTA PRESENÇA", "PELADA 4K", "", "✅ CONFIRMADOS", ""];
    confirmedGKs.forEach((p) => lines.push(`🥅 ${displayName(p)}`));
    confirmedNonGKs.forEach((p, i) => lines.push(`${numEmoji(i + 1)} ${displayName(p)}`));
    promotedAvulsoEntries.forEach((entry, i) =>
      lines.push(
        `${numEmoji(confirmedNonGKs.length + i + 1)} ${
          entry.kind === "player" ? displayName(entry.player) : entry.presence.guest_name
        } (avulso)`
      )
    );
    if (waitingAvulsoEntries.length > 0) {
      lines.push("", "🔔 AVULSOS (fila de espera)", "");
      waitingAvulsoEntries.forEach((entry, i) =>
        lines.push(`${numEmoji(i + 1)} ${entry.kind === "player" ? displayName(entry.player) : entry.presence.guest_name}`)
      );
    }
    if (absentPlayers.length > 0) {
      lines.push("", "❌ M. AUSENTES", "");
      absentPlayers.forEach((p, i) => lines.push(`${numEmoji(i + 1)} ${displayName(p)}`));
    }
    return lines.join("\n").trim();
  };

  // Se eu (jogador comum) sou um dos avulsos promovidos, mostro um aviso
  // assim que meu nome sobe — antes disso eu só via o aviso de "fila de
  // espera". A cobrança em si (com a chave PIX) só aparece às 13h de
  // segunda, quando a lista fecha com todos os avulsos e mensalistas
  // confirmados; se meu nome subiu antes disso, vejo só um "fique de olho"
  // sem a chave PIX ainda.
  // Mensalista que caiu pra fila de avulso por ter voltado tarde (late_rejoin)
  // já paga mensalidade — não mostra o aviso de PIX avulso se for promovido.
  const amIPromotedAvulso = !!(
    myPlayer &&
    promotedAvulsoEntries.some(
      (e) => e.kind === "player" && e.player.id === myPlayer.id && !isMensalista(e.player)
    )
  );
  useEffect(() => {
    if (!myPlayer || !pelada || !amIPromotedAvulso) return;
    const listClosed = isAfterMonday12hBRT();
    const stage = listClosed ? "cobranca" : "aviso";
    const storageKey = `pelada4k_avulso_promovido_${stage}_${pelada.id}_${myPlayer.id}`;
    try {
      if (localStorage.getItem(storageKey)) return;
      localStorage.setItem(storageKey, "1");
    } catch {
      /* localStorage indisponível — mostra assim mesmo, sem persistir */
    }
    setPaymentAlert(listClosed ? "avulso" : "avulso_promoted_early");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amIPromotedAvulso, pelada?.id, myPlayer?.id]);

  // Mensalista que o sistema colocou como ausente às 13h de segunda: avisa
  // (só na própria segunda, uma vez por pelada) que o prazo acabou.
  const myPresenceAutoAbsent = !!(
    myPlayer &&
    isMensalista(myPlayer) &&
    myPresence?.status === "absent" &&
    myPresence?.auto_absent
  );
  useEffect(() => {
    if (!myPlayer || !pelada || !myPresenceAutoAbsent || !isMondayBRT()) return;
    const storageKey = `pelada4k_auto_absent_${pelada.id}_${myPlayer.id}`;
    try {
      if (localStorage.getItem(storageKey)) return;
      localStorage.setItem(storageKey, "1");
    } catch {
      /* localStorage indisponível — mostra assim mesmo */
    }
    setPaymentAlert("auto_absent");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPresenceAutoAbsent, pelada?.id, myPlayer?.id]);

  const [presenceShareFallback, setPresenceShareFallback] = useState(null);
  const sharePresenceList = async () => {
    const text = presenceShareText();
    if (navigator.share) {
      try {
        await navigator.share({ text, title: "Lista de presença" });
        return;
      } catch {
        /* cancelou — cai no fallback */
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setToast("Copiado! Cole no WhatsApp.");
    } catch {
      setPresenceShareFallback(text);
    }
  };

  // Pop-up de confirmação ao cancelar presença / sair da lista de espera.
  // Renderizado dentro das listas (e não na raiz) pra aparecer também na
  // página da lista de presença.
  const iAmWaitingAvulso =
    !!myPresence && waitingAvulsoEntries.some((e) => e.presence.id === myPresence.id);
  const cancelConfirmModal = !cancelPresenceConfirm ? null : (
    <div className="modal-backdrop" style={{ zIndex: 10000 }} onClick={() => setCancelPresenceConfirm(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Opa!!!</h2>
        {cancelPresenceConfirm === "main" && iAmWaitingAvulso ? (
          <>
            <p className="field-hint" style={{ fontSize: 15 }}>
              Se você sair da lista de interesse na próxima pelada, perde a posição atual!
            </p>
            <p className="field-hint" style={{ fontSize: 15 }}>Deseja prosseguir?</p>
          </>
        ) : (
          <p className="field-hint" style={{ fontSize: 15 }}>
            Deseja cancelar sua presença na lista da próxima pelada?
          </p>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setCancelPresenceConfirm(null)}>
            NÃO
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              const kind = cancelPresenceConfirm;
              setCancelPresenceConfirm(null);
              if (kind === "extra") setMyExtraPresenceStatus("confirmed");
              else setMyPresenceStatus("confirmed");
            }}
          >
            SIM
          </button>
        </div>
      </div>
    </div>
  );

  // Conteúdo da lista de presença em si (meta da pelada, meus botões de
  // confirmar/ausência, CONFIRMADOS/AVULSOS/M.AUSENTES) — usado tanto inline
  // na home (quando aberta) quanto dentro do popup (quando o sorteio já saiu).
  const presenceListInner = !pelada ? null : (
    <>
      {myPlayer && myAccessBlocked && (
        <div className="access-blocked-box">
          <p className="access-blocked-text">
            <Emo e="🔒" /> Mensalidade de {monthKeyLabel(currentMonthKey())} pendente — o acesso à lista
            fica liberado assim que um administrador confirmar o pagamento.
          </p>
          <button className="btn btn-primary btn-block" onClick={() => setPaymentAlert("mensalista")}>
            Ver dados do PIX
          </button>
        </div>
      )}
      {myPlayer && !myAccessBlocked && (
        <div className="presence-my-actions">
          <button
            className={`btn ${amIConfirmed ? "btn-danger" : "btn-primary"}`}
            onClick={() => (amIConfirmed ? setCancelPresenceConfirm("main") : setMyPresenceStatus("confirmed"))}
          >
            {amIConfirmed
              ? !isMensalista(myPlayer) && iAmWaitingAvulso
                ? emo("↩ RETIRAR NOME DA LISTA DE ESPERA")
                : emo("✖ CANCELAR Presença")
              : !isMensalista(myPlayer)
              ? emo("⏳ ENTRAR NA LISTA DE ESPERA DE AVULSOS")
              : emo("✓ CONFIRMAR PRESENÇA")}
          </button>
          <button
            className={`btn ${amIAbsent ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setMyPresenceStatus("absent")}
          >
            {amIAbsent ? emo("↩ RETIRAR Ausência") : emo("❌ Marcar ausência")}
          </button>
        </div>
      )}
      {!isAdmin && myPlayer && !isMensalista(myPlayer) && (
        <div className="membership-interest-box">
          {myPlayer.membershipInterestAt ? (
            <p className="field-hint">
              <Emo e="✅" /> Pedido enviado em{" "}
              {new Date(myPlayer.membershipInterestAt).toLocaleDateString("pt-BR")} —
              aguardando aprovação de um administrador.
            </p>
          ) : (
            <button className="btn btn-ghost btn-block" onClick={expressMembershipInterest}>
              <Emo e="🏅" /> Tenho interesse em ser mensalista
            </button>
          )}
        </div>
      )}
      {!isAdmin && authUser && !myPlayer && (
        <p className="field-hint">
          Seu login ainda não foi vinculado a um card. Avise um administrador.
        </p>
      )}
      {!authUser && (
        <p className="field-hint">
          <button className="link" onClick={() => setShowAccountModal(true)}>
            Entre ou crie sua conta
          </button>{" "}
          para confirmar presença ou marcar ausência.
        </p>
      )}

      {confirmedGKs.length > 0 && (
        <>
          <GroupTitle kind="gk">GOLEIROS</GroupTitle>
          <ul className="presence-card-list">
            {confirmedGKs.map((p) => (
              <PresenceRowCard
                key={p.id}
                player={p}
                subtitle={tempSubtitle(p, "")}
                statusLabel="PRESENTE"
                statusTone="green"
                onClick={() => setViewPlayer(p)}
                byTag={
                  isAdmin && presenceMarkedByAdmin(presenceByPlayerId.get(p.id), p)
                    ? `— ${presenceMarkedByAdmin(presenceByPlayerId.get(p.id), p)}`
                    : null
                }
                onRemove={isAdmin ? () => adminSetPlayerPresence(p.id, null) : null}
              />
            ))}
          </ul>
        </>
      )}

      <GroupTitle kind="ok">CONFIRMADOS</GroupTitle>
      <ul className="presence-card-list">
        {confirmedNonGKs.map((p) => (
          <PresenceRowCard
            key={p.id}
            player={p}
            subtitle={tempSubtitle(p, "")}
            statusLabel="PRESENTE"
            statusTone="green"
            onClick={() => setViewPlayer(p)}
            byTag={
              isAdmin && presenceMarkedByAdmin(presenceByPlayerId.get(p.id), p)
                ? `— ${presenceMarkedByAdmin(presenceByPlayerId.get(p.id), p)}`
                : null
            }
            adminExtra={
              isAdmin && !p.isGK && !membershipPayments[p.id]?.paid ? alertButton(p, "mensalista") : null
            }
            onRemove={isAdmin ? () => adminSetPlayerPresence(p.id, null) : null}
          />
        ))}
        {promotedAvulsoEntries.map((entry) =>
          entry.kind === "player" ? (
            <PresenceRowCard
              key={`pa-${entry.player.id}`}
              player={entry.player}
              subtitle={
                entry.presence.late_rejoin
                  ? "RETORNOU TARDE"
                  : entry.presence.manually_promoted
                  ? "AVULSO (SUBIU DIRETO)"
                  : "AVULSO"
              }
              statusLabel="PRESENTE"
              statusTone="green"
              autoTag={systemPromotedPresenceIds.has(entry.presence.id) ? "PRESENÇA AUTOMÁTICA PELO SISTEMA" : null}
              onClick={() => setViewPlayer(entry.player)}
              byTag={
                isAdmin && presenceMarkedByAdmin(entry.presence, entry.player)
                  ? `— ${presenceMarkedByAdmin(entry.presence, entry.player)}`
                  : null
              }
              adminExtra={
                isAdmin ? (
                  <>
                    {!isMensalista(entry.player) && !entry.presence.paid && alertButton(entry.player, "avulso")}
                    {!isMensalista(entry.player) && (
                      <button
                        className={`paid-pill ${entry.presence.paid ? "paid-pill-paid" : "paid-pill-pending"}`}
                        onClick={() => setPresencePaid(entry.presence.id, !entry.presence.paid)}
                      >
                        {entry.presence.paid ? emo("✔ pagamento confirmado") : "pagamento pendente"}
                      </button>
                    )}
                    {entry.presence.manually_promoted && (
                      <button
                        className="link presence-promote-btn"
                        onClick={() => demoteAvulso(entry.presence.id)}
                      >
                        tirar da lista principal
                      </button>
                    )}
                  </>
                ) : null
              }
              onRemove={isAdmin ? () => adminSetPlayerPresence(entry.player.id, null) : null}
            />
          ) : (
            <PresenceRowCard
              key={`ga-${entry.presence.id}`}
              guestName={entry.presence.guest_name}
              subtitle={entry.presence.manually_promoted ? "AVULSO (SUBIU DIRETO)" : "AVULSO"}
              statusLabel="PRESENTE"
              statusTone="green"
              autoTag={systemPromotedPresenceIds.has(entry.presence.id) ? "PRESENÇA AUTOMÁTICA PELO SISTEMA" : null}
              byTag={
                isAdmin && presenceMarkedByAdmin(entry.presence, null)
                  ? `— ${presenceMarkedByAdmin(entry.presence, null)}`
                  : null
              }
              adminExtra={
                isAdmin ? (
                  <>
                    <button
                      className={`paid-pill ${entry.presence.paid ? "paid-pill-paid" : "paid-pill-pending"}`}
                      onClick={() => setPresencePaid(entry.presence.id, !entry.presence.paid)}
                    >
                      {entry.presence.paid ? emo("✔ pagamento confirmado") : "pagamento pendente"}
                    </button>
                    {entry.presence.manually_promoted && (
                      <button
                        className="link presence-promote-btn"
                        onClick={() => demoteAvulso(entry.presence.id)}
                      >
                        tirar da lista principal
                      </button>
                    )}
                  </>
                ) : null
              }
              onRemove={isAdmin ? () => adminRemoveGuest(entry.presence.id) : null}
            />
          )
        )}
        {confirmedNonGKs.length === 0 && promotedAvulsoEntries.length === 0 && (
          <p className="empty-hint">Ninguém confirmou presença ainda.</p>
        )}
      </ul>

      {isAdmin && (
        <PresenceAdminAdd
          players={players.filter(isMensalista)}
          presentIds={presentPlayerIds}
          onAdd={(id) => adminSetPlayerPresence(id, "confirmed")}
        />
      )}

      {(waitingAvulsoEntries.length > 0 || isAdmin) && (
        <>
          <GroupTitle kind="ticket">AVULSOS (fila de espera)</GroupTitle>
          {isAdmin && waitingAvulsoEntries.length > 1 && (
            <p className="field-hint">
              Use as setas pra mudar a ordem da fila — quem está mais em cima sobe primeiro pra
              CONFIRMADOS.
            </p>
          )}
          <ul className="presence-card-list">
            {waitingAvulsoEntries.map((entry, i) =>
              entry.kind === "player" ? (
                <PresenceRowCard
                  key={`p-${entry.player.id}`}
                  player={entry.player}
                  subtitle={entry.presence.late_rejoin ? "RETORNOU TARDE" : "NA FILA"}
                  statusLabel="PENDENTE"
                  statusTone="yellow"
                  queueNum={i + 1}
                  onClick={() => setViewPlayer(entry.player)}
                  onReorderUp={isAdmin ? () => reorderAvulsoQueue(entry.presence.id, "up") : null}
                  onReorderDown={isAdmin ? () => reorderAvulsoQueue(entry.presence.id, "down") : null}
                  reorderUpDisabled={i === 0}
                  reorderDownDisabled={i === waitingAvulsoEntries.length - 1}
                  byTag={
                    isAdmin && presenceMarkedByAdmin(entry.presence, entry.player)
                      ? `— ${presenceMarkedByAdmin(entry.presence, entry.player)}`
                      : null
                  }
                  adminExtra={
                    isAdmin ? (
                      <button
                        className="link presence-promote-btn"
                        onClick={() => promoteAvulso(entry.presence.id)}
                      >
                        <Emo e="⬆️" /> subir pra lista agora
                      </button>
                    ) : null
                  }
                  onRemove={isAdmin ? () => adminSetPlayerPresence(entry.player.id, null) : null}
                />
              ) : (
                <PresenceRowCard
                  key={`g-${entry.presence.id}`}
                  guestName={entry.presence.guest_name}
                  subtitle="NA FILA"
                  statusLabel="PENDENTE"
                  statusTone="yellow"
                  queueNum={i + 1}
                  onReorderUp={isAdmin ? () => reorderAvulsoQueue(entry.presence.id, "up") : null}
                  onReorderDown={isAdmin ? () => reorderAvulsoQueue(entry.presence.id, "down") : null}
                  reorderUpDisabled={i === 0}
                  reorderDownDisabled={i === waitingAvulsoEntries.length - 1}
                  byTag={
                    isAdmin && presenceMarkedByAdmin(entry.presence, null)
                      ? `— ${presenceMarkedByAdmin(entry.presence, null)}`
                      : null
                  }
                  adminExtra={
                    isAdmin ? (
                      <button
                        className="link presence-promote-btn"
                        onClick={() => promoteAvulso(entry.presence.id)}
                      >
                        <Emo e="⬆️" /> subir pra lista agora
                      </button>
                    ) : null
                  }
                  onRemove={isAdmin ? () => adminRemoveGuest(entry.presence.id) : null}
                />
              )
            )}
            {waitingAvulsoEntries.length === 0 && <p className="empty-hint">Nenhum avulso na fila.</p>}
          </ul>
          {isAdmin && (
            <PresenceAdminAdd
              players={players.filter((p) => !isMensalista(p))}
              presentIds={presentPlayerIds}
              onAdd={(id) => adminSetPlayerPresence(id, "confirmed")}
            />
          )}
          {isAdmin && <PresenceAdminAddGuest onAdd={adminAddGuest} />}
        </>
      )}

      {(absentPlayers.length > 0 || isAdmin) && (
        <>
          <GroupTitle kind="out">M. AUSENTES</GroupTitle>
          <ul className="presence-card-list">
            {absentPlayers.map((p) => (
              <PresenceRowCard
                key={p.id}
                player={p}
                subtitle={undefined}
                statusLabel="AUSENTE"
                statusTone="red"
                autoTag={presenceByPlayerId.get(p.id)?.auto_absent ? "AUSENTE AUTOMÁTICO PELO SISTEMA" : null}
                onClick={() => setViewPlayer(p)}
                byTag={
                  isAdmin && presenceMarkedByAdmin(presenceByPlayerId.get(p.id), p)
                    ? `— ${presenceMarkedByAdmin(presenceByPlayerId.get(p.id), p)}`
                    : null
                }
                onRemove={isAdmin ? () => adminSetPlayerPresence(p.id, null) : null}
              />
            ))}
            {absentPlayers.length === 0 && <p className="empty-hint">Ninguém marcou ausência ainda.</p>}
          </ul>
        </>
      )}

      {(confirmedMensalistas.length > 0 || avulsoEntries.length > 0 || absentPlayers.length > 0) && (
        <button className="btn btn-ghost btn-block presence-share-btn" onClick={sharePresenceList}>
          <Emo e="📲" /> Copiar lista para o WhatsApp
        </button>
      )}
      {cancelPresenceConfirm === "main" && cancelConfirmModal}
    </>
  );

  // Conteúdo da lista de presença EXTRA — versão "livre": sem bloqueio de
  // mensalidade, sem fila de avulso, sem pedido de mensalista. Qualquer
  // jogador cadastrado confirma direto, goleiro entra em GOLEIROS e o resto
  // (cadastrados + avulsos externos) entra direto em CONFIRMADOS.
  const presenceListInnerExtra = !peladaExtra ? null : (
    <>
      {myPlayer && (
        <div className="presence-my-actions">
          <button
            className={`btn ${amIConfirmedExtra ? "btn-danger" : "btn-primary"}`}
            onClick={() => (amIConfirmedExtra ? setCancelPresenceConfirm("extra") : setMyExtraPresenceStatus("confirmed"))}
          >
            {amIConfirmedExtra ? emo("✖ CANCELAR Presença") : emo("✓ CONFIRMAR PRESENÇA")}
          </button>
          <button
            className={`btn ${amIAbsentExtra ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setMyExtraPresenceStatus("absent")}
          >
            {amIAbsentExtra ? emo("↩ RETIRAR Ausência") : emo("❌ Marcar ausência")}
          </button>
        </div>
      )}
      {!isAdmin && authUser && !myPlayer && (
        <p className="field-hint">
          Seu login ainda não foi vinculado a um card. Avise um administrador.
        </p>
      )}
      {!authUser && (
        <p className="field-hint">
          <button className="link" onClick={() => setShowAccountModal(true)}>
            Entre ou crie sua conta
          </button>{" "}
          para confirmar presença ou marcar ausência.
        </p>
      )}

      {confirmedExtraGKs.length > 0 && (
        <>
          <GroupTitle kind="gk">GOLEIROS</GroupTitle>
          <ul className="presence-card-list">
            {confirmedExtraGKs.map((p) => (
              <PresenceRowCard
                key={p.id}
                player={p}
                subtitle={undefined}
                statusLabel="PRESENTE"
                statusTone="green"
                onClick={() => setViewPlayer(p)}
                byTag={
                  isAdmin && presenceMarkedByAdmin(presenceByPlayerIdExtra.get(p.id), p)
                    ? `— ${presenceMarkedByAdmin(presenceByPlayerIdExtra.get(p.id), p)}`
                    : null
                }
                onRemove={isAdmin ? () => adminSetExtraPlayerPresence(p.id, null) : null}
              />
            ))}
          </ul>
        </>
      )}

      <GroupTitle kind="ok">CONFIRMADOS</GroupTitle>
      <ul className="presence-card-list">
        {confirmedExtraNonGKs.map((p) => (
          <PresenceRowCard
            key={p.id}
            player={p}
            subtitle={undefined}
            statusLabel="PRESENTE"
            statusTone="green"
            onClick={() => setViewPlayer(p)}
            byTag={
              isAdmin && presenceMarkedByAdmin(presenceByPlayerIdExtra.get(p.id), p)
                ? `— ${presenceMarkedByAdmin(presenceByPlayerIdExtra.get(p.id), p)}`
                : null
            }
            onRemove={isAdmin ? () => adminSetExtraPlayerPresence(p.id, null) : null}
          />
        ))}
        {confirmedExtraGuests.map((pr) => (
          <PresenceRowCard
            key={`ge-${pr.id}`}
            guestName={pr.guest_name}
            subtitle="AVULSO"
            statusLabel="PRESENTE"
            statusTone="green"
            byTag={
              isAdmin && presenceMarkedByAdmin(pr, null) ? `— ${presenceMarkedByAdmin(pr, null)}` : null
            }
            onRemove={isAdmin ? () => adminRemoveGuestExtra(pr.id) : null}
          />
        ))}
        {confirmedExtraNonGKs.length === 0 && confirmedExtraGuests.length === 0 && (
          <p className="empty-hint">Ninguém confirmou presença ainda.</p>
        )}
      </ul>

      {isAdmin && (
        <PresenceAdminAdd
          players={players}
          presentIds={presentPlayerIdsExtra}
          onAdd={(id) => adminSetExtraPlayerPresence(id, "confirmed")}
        />
      )}
      {isAdmin && <PresenceAdminAddGuest onAdd={adminAddGuestExtra} />}

      {(absentExtraPlayers.length > 0 || isAdmin) && (
        <>
          <GroupTitle kind="out">M. AUSENTES</GroupTitle>
          <ul className="presence-card-list">
            {absentExtraPlayers.map((p) => (
              <PresenceRowCard
                key={p.id}
                player={p}
                subtitle={undefined}
                statusLabel="AUSENTE"
                statusTone="red"
                onClick={() => setViewPlayer(p)}
                byTag={
                  isAdmin && presenceMarkedByAdmin(presenceByPlayerIdExtra.get(p.id), p)
                    ? `— ${presenceMarkedByAdmin(presenceByPlayerIdExtra.get(p.id), p)}`
                    : null
                }
                onRemove={isAdmin ? () => adminSetExtraPlayerPresence(p.id, null) : null}
              />
            ))}
            {absentExtraPlayers.length === 0 && <p className="empty-hint">Ninguém marcou ausência ainda.</p>}
          </ul>
        </>
      )}
      {cancelPresenceConfirm === "extra" && cancelConfirmModal}
    </>
  );

  // Puxa quem confirmou presença pra tela de seleção do sorteio, já
  // marcado — o admin só ajusta se precisar.
  const pullPresenceIntoSelection = () => {
    // Só puxa quem está de fato na lista oficial: mensalistas confirmados
    // (goleiros incluídos) + avulsos já promovidos da fila de espera —
    // avulso ainda esperando a vez não entra no sorteio.
    const officialIds = new Set([
      ...confirmedGKs.map((p) => p.id),
      ...confirmedNonGKs.map((p) => p.id),
      ...promotedAvulsoEntries.filter((e) => e.kind === "player").map((e) => e.player.id),
    ]);
    setSelectedIds(officialIds);
  };

  // Admin: histórico de listas de presença já encerradas (a publicação e o
  // encerramento automáticos, toda sexta e quarta, nunca apagam nada — só
  // fecham a pelada; o histórico é justamente essas linhas fechadas).
  const openHistory = async () => {
    setShowHistory(true);
    setHistoryLoading(true);
    const { data: peladaRows } = await supabase
      .from("peladas")
      .select("*")
      .in("status", ["closed", "deleted"])
      .order("scheduled_for", { ascending: false, nullsFirst: false })
      .limit(30);
    const ids = (peladaRows || []).map((r) => r.id);
    let presenceRows = [];
    if (ids.length > 0) {
      const { data } = await supabase.from("presences").select("*").in("pelada_id", ids);
      presenceRows = data || [];
    }
    setHistory(
      (peladaRows || []).map((row) => ({
        pelada: rowToPelada(row),
        presences: presenceRows.filter((p) => p.pelada_id === row.id),
      }))
    );
    setHistoryLoading(false);
  };

  // Sugestões de melhoria: qualquer pessoa logada manda um recado (pro
  // sistema ou pra pelada), e o admin vê quem mandou.
  const openSuggestions = async () => {
    setShowSuggestions(true);
    setSuggestionsLoading(true);
    const { data } = await supabase
      .from("suggestions")
      .select("*")
      .order("created_at", { ascending: false });
    setSuggestions(data || []);
    setSuggestionsUnreadCount((data || []).filter((s) => s.status !== "read").length);
    setSuggestionsLoading(false);
    // Marca tudo como lido ao abrir — o badge de "novas" só conta enquanto
    // ninguém do admin ainda viu.
    const unreadIds = (data || []).filter((s) => s.status !== "read").map((s) => s.id);
    if (unreadIds.length > 0) {
      await supabase.from("suggestions").update({ status: "read" }).in("id", unreadIds);
      setSuggestionsUnreadCount(0);
    }
  };

  const deleteSuggestion = async (id) => {
    const { error } = await supabase.from("suggestions").delete().eq("id", id);
    if (!error) setSuggestions((prev) => prev.filter((s) => s.id !== id));
  };

  // Qualquer pessoa logada (com ou sem card vinculado) pode mandar uma
  // sugestão — identificando quem mandou pra o admin poder responder.
  const sendSuggestion = async (message) => {
    if (!authUser || !message.trim()) return false;
    const authorName = myPlayer ? displayName(myPlayer) : authUser.email;
    const { error } = await supabase.from("suggestions").insert({
      player_id: myPlayer?.id ?? null,
      author_name: authorName,
      author_email: authUser.email,
      message: message.trim(),
    });
    if (error) {
      setToast("Não foi possível enviar a sugestão. Tente novamente.");
      return false;
    }
    setToast("Sugestão enviada! Obrigado!");
    return true;
  };

  // Stories: carrega só os que ainda não expiraram (o "some sozinho depois
  // de 24h" é feito aqui, filtrando — a linha continua no banco, mas para
  // de aparecer).
  const loadStories = async () => {
    const { data } = await supabase
      .from("stories")
      .select("*")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: true });
    setStories(data || []);
  };

  const markStorySeen = (id) => {
    setSeenStoryIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem("pelada4k_seen_stories", JSON.stringify([...next]));
      } catch {
        /* localStorage indisponível (modo privado, etc.) — sem problema, só não lembra depois */
      }
      return next;
    });
  };

  // Sobe a foto/vídeo pro Storage e cria a linha do story. Foto passa pelo
  // mesmo redimensionamento das outras fotos do app; vídeo sobe direto (o
  // navegador não tem como comprimir vídeo sozinho), com um limite de
  // tamanho pra não travar o upload de quem tem internet mais lenta.
  const uploadStory = async (file) => {
    if (!authUser || !myPlayer) {
      setToast("Você precisa estar logado e ter um card vinculado pra postar um story.");
      return;
    }
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    if (!isImage && !isVideo) {
      setToast("Envie uma foto ou um vídeo.");
      return;
    }
    if (isVideo && file.size > 60 * 1024 * 1024) {
      setToast("Vídeo muito grande (máx. 60MB) — tenta um vídeo mais curto.");
      return;
    }
    setUploadingStory(true);
    try {
      let blob, contentType, ext;
      if (isImage) {
        const dataUrl = await resizeImage(file, 1080, 0.85);
        blob = await (await fetch(dataUrl)).blob();
        contentType = "image/jpeg";
        ext = "jpg";
      } else {
        // Pode vir de um <input type="file"> (tem .name) ou de um Blob
        // gravado na hora pela câmera interna do app (sem .name).
        blob = file;
        contentType = file.type || "video/mp4";
        if (file.name) {
          ext = (file.name.split(".").pop() || "mp4").toLowerCase();
        } else if (contentType.includes("mp4")) {
          ext = "mp4";
        } else {
          ext = "webm";
        }
      }
      const path = `${myPlayer.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("stories")
        .upload(path, blob, { contentType, upsert: true });
      if (upErr) throw upErr;
      const { data: urlData } = supabase.storage.from("stories").getPublicUrl(path);
      const { error: insErr } = await supabase.from("stories").insert({
        player_id: myPlayer.id,
        media_url: urlData.publicUrl,
        media_path: path,
        media_type: isImage ? "image" : "video",
      });
      if (insErr) throw insErr;
      setToast("Story publicado!");
      await loadStories();
    } catch {
      setToast("Não foi possível publicar o story. Verifique sua conexão e tente de novo.");
    } finally {
      setUploadingStory(false);
    }
  };

  const deleteStory = async (id) => {
    const story = stories.find((s) => s.id === id);
    const { error } = await supabase.from("stories").delete().eq("id", id);
    if (!error) {
      setStories((prev) => prev.filter((s) => s.id !== id));
      if (story?.media_path) {
        try {
          await supabase.storage.from("stories").remove([story.media_path]);
        } catch {
          /* linha já apagada; se sobrar o arquivo, a limpeza automática cuida depois */
        }
      }
    }
  };

  // Registra visualização / curtida / reação num story — sempre a própria
  // pessoa (RLS só deixa gravar a própria linha). "patch" é só o que muda
  // (ex.: { liked_at: ... } ou { reaction, reacted_at }); o resto da linha
  // (viewed_at, etc.) é combinado no upsert.
  const upsertStoryInteraction = async (storyId, patch) => {
    if (!authUser || !myPlayer) return null;
    const { data, error } = await supabase
      .from("story_interactions")
      .upsert(
        { story_id: storyId, player_id: myPlayer.id, updated_at: new Date().toISOString(), ...patch },
        { onConflict: "story_id,player_id" }
      )
      .select()
      .single();
    if (error) return null;
    return data;
  };

  const recordStoryView = (storyId) => upsertStoryInteraction(storyId, { viewed_at: new Date().toISOString() });

  const toggleStoryLike = (storyId, nextLiked) =>
    upsertStoryInteraction(storyId, { liked_at: nextLiked ? new Date().toISOString() : null });

  const sendStoryReaction = (storyId, emoji) =>
    upsertStoryInteraction(storyId, { reaction: emoji, reacted_at: new Date().toISOString() });

  const fetchMyStoryInteraction = async (storyId) => {
    if (!myPlayer) return null;
    const { data } = await supabase
      .from("story_interactions")
      .select("*")
      .eq("story_id", storyId)
      .eq("player_id", myPlayer.id)
      .maybeSingle();
    return data;
  };

  // Só o dono do story (ou admin) consegue puxar isso de verdade — RLS
  // barra pra qualquer outra pessoa, então nem tenta chamar fora desse caso.
  const fetchStoryViewers = async (storyId) => {
    const { data } = await supabase
      .from("story_interactions")
      .select("*")
      .eq("story_id", storyId)
      .not("viewed_at", "is", null)
      .order("updated_at", { ascending: false });
    return data || [];
  };

  // Admin: controle financeiro — busca todo o histórico de recebimentos
  // (mensalidades e avulsos já marcados como pagos, de qualquer pelada ou
  // mês) e as saídas registradas, pra montar o caixa de cada admin.
  const openFinance = async () => {
    setShowFinance(true);
    setFinanceLoading(true);
    const [mensalidadesRes, avulsosRes, expensesRes, peladasRes] = await Promise.all([
      supabase.from("membership_payments").select("*").eq("paid", true),
      supabase.from("presences").select("*").eq("paid", true),
      supabase.from("cash_expenses").select("*").order("created_at", { ascending: false }),
      supabase.from("peladas").select("id, scheduled_for, created_at, kind"),
    ]);
    setFinanceData({
      mensalidades: mensalidadesRes.data || [],
      avulsos: avulsosRes.data || [],
      expenses: expensesRes.data || [],
      peladas: peladasRes.data || [],
    });
    setFinanceLoading(false);
  };

  // Admin: move um recebimento pra outro caixa (ex.: o dinheiro caiu em outro
  // PIX). kind: "mensalidade" | "avulso".
  const moveFinanceIncome = async (kind, rec, newOwnerId) => {
    const query =
      kind === "mensalidade"
        ? supabase
            .from("membership_payments")
            .update({ caixa_id: newOwnerId })
            .eq("player_id", rec.player_id)
            .eq("month", rec.month)
        : supabase.from("presences").update({ caixa_id: newOwnerId }).eq("id", rec.id);
    const { error } = await query;
    if (error) {
      setToast("Não foi possível mover o recebimento.");
      return;
    }
    setFinanceData((prev) =>
      kind === "mensalidade"
        ? {
            ...prev,
            mensalidades: prev.mensalidades.map((m) =>
              m.player_id === rec.player_id && m.month === rec.month ? { ...m, caixa_id: newOwnerId } : m
            ),
          }
        : { ...prev, avulsos: prev.avulsos.map((a) => (a.id === rec.id ? { ...a, caixa_id: newOwnerId } : a)) }
    );
  };

  // Admin: estorna um recebimento (desmarca o pago) direto pelo financeiro —
  // o jogador volta a aparecer como "pendente" no controle de pagamentos.
  const refundFinanceIncome = async (kind, rec) => {
    if (kind === "mensalidade") {
      const { error } = await supabase
        .from("membership_payments")
        .update({ paid: false, paid_at: null, caixa_id: null, updated_by: authUser?.id })
        .eq("player_id", rec.player_id)
        .eq("month", rec.month);
      if (error) return setToast("Não foi possível estornar.");
      setFinanceData((prev) => ({
        ...prev,
        mensalidades: prev.mensalidades.filter((m) => !(m.player_id === rec.player_id && m.month === rec.month)),
      }));
      if (rec.month === currentMonthKey()) {
        setMembershipPayments((prev) => ({ ...prev, [rec.player_id]: { paid: false, paidAt: null } }));
      }
    } else {
      const { data, error } = await supabase
        .from("presences")
        .update({ paid: false, paid_by: null, paid_at: null, caixa_id: null })
        .eq("id", rec.id)
        .select()
        .single();
      if (error) return setToast("Não foi possível estornar.");
      setFinanceData((prev) => ({ ...prev, avulsos: prev.avulsos.filter((a) => a.id !== rec.id) }));
      setPresences((prev) => prev.map((p) => (p.id === rec.id ? data : p)));
    }
    setToast("Recebimento estornado.");
  };

  // Saída registrada no caixa que está sendo visto (qualquer admin pode
  // lançar/remover em qualquer caixa).
  const addCashExpense = async (description, amount, caixaId) => {
    const { data, error } = await supabase
      .from("cash_expenses")
      .insert({ admin_id: authUser?.id, description, amount, caixa_id: caixaId })
      .select()
      .single();
    if (!error) {
      setFinanceData((prev) => ({ ...prev, expenses: [data, ...prev.expenses] }));
    } else {
      setToast("Não foi possível registrar a saída. Tente novamente.");
    }
  };

  const deleteCashExpense = async (id) => {
    const { error } = await supabase.from("cash_expenses").delete().eq("id", id);
    if (!error) {
      setFinanceData((prev) => ({ ...prev, expenses: prev.expenses.filter((e) => e.id !== id) }));
    }
  };

  const saveMyProfile = async (fields) => {
    if (!myPlayer) return;
    const row = {
      nickname: fields.nickname,
      favorite_team: fields.favoriteTeam,
      ...(fields.shirtNumber != null || fields.shirtNumberClear ? { shirt_number: fields.shirtNumber ?? null } : {}),
      instagram: fields.instagram,
      is_gk: !!fields.isGK,
      position: fields.position ?? null,
      photo_url: fields.photo,
      photo_position: fields.photoPosition,
      cover1_url: fields.cover1,
      cover2_url: fields.cover2,
      cover3_url: fields.cover3,
      cover4_url: fields.cover4,
      cover5_url: fields.cover5,
      cover1_position: fields.cover1Position || "50% 50%",
      cover2_position: fields.cover2Position || "50% 50%",
      cover3_position: fields.cover3Position || "50% 50%",
      cover4_position: fields.cover4Position || "50% 50%",
      cover5_position: fields.cover5Position || "50% 50%",
    };
    const { data, error } = await supabase
      .from("players")
      .update(row)
      .eq("id", myPlayer.id)
      .select()
      .single();
    if (error) {
      console.error("Erro ao salvar card:", error);
      setToast(
        error.message ? `Não foi possível salvar: ${error.message}` : "Não foi possível salvar seu card. Tente novamente."
      );
    } else {
      const updated = rowToPlayer(data);
      setPlayers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    }
    // Telefone é próprio (RLS só deixa o dono ou admin mexer nisso).
    await supabase.from("player_contacts").upsert({ player_id: myPlayer.id, phone: fields.phone || null });
    setContacts((prev) => ({ ...prev, [myPlayer.id]: fields.phone || null }));
    setShowMyProfileForm(false);
  };

  const linkUserToPlayer = async (playerId, userId) => {
    const { data, error } = await supabase
      .from("players")
      .update({ user_id: userId })
      .eq("id", playerId)
      .select()
      .single();
    if (error) {
      setToast("Não foi possível vincular o login. Tente novamente.");
    } else {
      const updated = rowToPlayer(data);
      setPlayers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    }
  };

  // Promove/remove administrador. Impede remover a si mesmo (pra não
  // ninguém trancar o próprio acesso por engano) — outro admin remove.
  const grantAdmin = async (userId) => {
    const { error } = await supabase.from("admins").insert({ user_id: userId });
    if (!error) setAdminUserIds((prev) => new Set(prev).add(userId));
    else setToast("Não foi possível promover essa conta a administrador.");
  };
  const revokeAdmin = async (userId) => {
    if (userId === authUser?.id) {
      setToast("Você não pode remover seu próprio acesso de administrador.");
      return;
    }
    const { error } = await supabase.from("admins").delete().eq("user_id", userId);
    if (!error) {
      setAdminUserIds((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    } else {
      setToast("Não foi possível remover essa conta de administrador.");
    }
  };

  const publishList = async () => {
    if (!result) return;
    const { error } = await supabase.from("published_list").upsert({
      id: PUBLISHED_LIST_ID,
      teams: result.teams,
      consider_gk: result.considerGK,
      diff: result.diff,
      stars: result.stars,
      label: result.label,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      setToast("Não foi possível publicar a lista. Verifique sua conexão.");
    } else {
      setPublishedList({
        teams: result.teams,
        considerGK: result.considerGK,
        diff: result.diff,
        stars: result.stars,
        label: result.label,
        updatedAt: new Date().toISOString(),
      });
      setJustPublished(true);
      setToast("Lista publicada! Já aparece na página inicial.");
    }
  };

  const unpublishList = async () => {
    const { error } = await supabase.from("published_list").delete().eq("id", PUBLISHED_LIST_ID);
    if (error) {
      setToast("Não foi possível excluir a lista. Confirme se você está logado como administrador.");
    } else {
      setPublishedList(null);
    }
  };

  // Admin: publica um aviso (substitui o anterior, se houver) — aparece em
  // popup na hora, pra quem já está com o app aberto, e também abre sozinho
  // pra quem entrar depois (até ser fechado/expirar, conforme o modo).
  const publishAnnouncement = async ({ title, message, mode, expiresAt }) => {
    const { data, error } = await supabase
      .from("announcements")
      .upsert({
        id: ANNOUNCEMENT_ID,
        title: title.trim() || null,
        message: message.trim(),
        mode,
        expires_at: mode === "until_date" && expiresAt ? expiresAt : null,
        created_by: authUser?.id,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) {
      setToast("Não foi possível publicar o aviso.");
    } else {
      setAnnouncement(rowToAnnouncement(data));
      setShowAnnouncementAdmin(false);
      setToast("Aviso publicado!");
    }
  };
  const clearAnnouncement = async () => {
    const { error } = await supabase.from("announcements").delete().eq("id", ANNOUNCEMENT_ID);
    if (!error) {
      setAnnouncement(null);
      setShowAnnouncementPopup(false);
    }
  };

  const savePlayer = async (fields) => {
    const { id, phone, ...playerFields } = fields;
    const row = playerToRow(playerFields);
    if (formPlayer) {
      const { data, error } = await supabase.from("players").update(row).eq("id", id).select().single();
      if (error) {
        console.error("Erro ao salvar jogador:", error);
        setToast(
          error.message
            ? `Não foi possível salvar: ${error.message}`
            : "Não foi possível salvar. Confirme se você está logado como administrador."
        );
      } else {
        const updated = rowToPlayer(data);
        setPlayers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      }
    } else {
      const { data, error } = await supabase.from("players").insert({ id, ...row }).select().single();
      if (error) {
        console.error("Erro ao cadastrar jogador:", error);
        setToast(
          error.message
            ? `Não foi possível cadastrar: ${error.message}`
            : "Não foi possível cadastrar. Confirme se você está logado como administrador."
        );
      } else {
        setPlayers((prev) => [...prev, rowToPlayer(data)]);
      }
    }
    // Telefone mora numa tabela separada (player_contacts) — só admin/dono
    // consegue ler, então fica de fora da tabela "players" (essa é pública).
    await supabase.from("player_contacts").upsert({ player_id: id, phone: phone || null });
    setContacts((prev) => ({ ...prev, [id]: phone || null }));
    setFormPlayer(undefined);
  };

  const deletePlayer = async (id) => {
    const { error } = await supabase.from("players").delete().eq("id", id);
    if (error) {
      setToast("Não foi possível excluir. Confirme se você está logado como administrador.");
    } else {
      setPlayers((prev) => prev.filter((x) => x.id !== id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
    setFormPlayer(undefined);
  };

  // ---- login individual (Supabase Auth) ----
  const handleSignIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, message: error.message };
    setShowAccountModal(false);
    return { ok: true };
  };
  const handleSignUp = async (email, password, fullName) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName || null } },
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  };
  const handleResetPassword = async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  };
  const handleUpdatePassword = async (password) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return { ok: false, message: error.message };
    setShowSetNewPassword(false);
    setToast("Senha atualizada!");
    return { ok: true };
  };
  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setShowAccountModal(false);
  };

  // ---- toast ----
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- trava de segurança extra: se por qualquer motivo a sessão de admin
  // cair (expirar, logout em outra aba) enquanto estiver no meio do fluxo de
  // sorteio, volta pra home na hora — usuário comum nunca fica "preso" numa
  // tela de edição/sorteio.
  useEffect(() => {
    if (!isAdmin && screen !== "roster") {
      setScreen("roster");
    }
  }, [isAdmin, screen]);


  // Ordem da home: aleatória por carregamento da página, com prioridade pra
  // quem tem foto de perfil e capa (ver sortRosterForHome).
  const rosterDisplayList = sortRosterForHome(players);

  const alphabeticalPlayers = [...players].sort((a, b) =>
    displayName(a).localeCompare(displayName(b), "pt-BR", { sensitivity: "base" })
  );

  // Stories agrupados por jogador, pessoa com o story mais recente primeiro
  // (a sua própria fileira entra à parte, sempre em primeiro, no componente).
  const storiesByPlayer = {};
  stories.forEach((s) => {
    if (!storiesByPlayer[s.player_id]) storiesByPlayer[s.player_id] = [];
    storiesByPlayer[s.player_id].push(s);
  });
  const storyPlayerIds = Object.keys(storiesByPlayer).sort((a, b) => {
    const latest = (id) => Math.max(...storiesByPlayer[id].map((s) => new Date(s.created_at).getTime()));
    return latest(b) - latest(a);
  });

  // ---- seleção ----
  const toggleSelect = (id) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const selectedPlayers = players.filter((p) => selectedIds.has(p.id));
  const selectedGKCount = selectedPlayers.filter((p) => p.isGK).length;

  const goToSelect = () => {
    setScreen("select");
  };

  const goToConfig = () => {
    setNumTeams(selectedPlayers.length >= 9 ? 3 : 2);
    setSeparateGroups([
      ["", "", ""],
      ["", "", ""],
    ]);
    setTogetherRules([]);
    setScreen("config");
  };

  // ---- regras ----
  // Cada grupo de "separar" vira todas as combinações de pares 🚫 entre os
  // jogadores preenchidos naquele grupo (2 ou 3 jogadores que nunca podem
  // ficar juntos entre si).
  const derivedSeparateRules = () => {
    const out = [];
    separateGroups.forEach((group) => {
      const ids = [...new Set(group.filter(Boolean))];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          out.push({ id: uid("r"), type: "separar", a: ids[i], b: ids[j] });
        }
      }
    });
    return out;
  };
  const effectiveRules = () => [
    ...derivedSeparateRules(),
    ...togetherRules.map((r) => ({ ...r, type: "juntos" })),
  ];

  const ruleConflict = (() => {
    const { error } = buildUnits(selectedPlayers, effectiveRules(), "regras");
    return error === "conflito";
  })();

  const setGroupSlot = (groupIndex, slotIndex, playerId) => {
    setSeparateGroups((prev) => {
      const next = prev.map((g) => [...g]);
      next[groupIndex][slotIndex] = playerId;
      return next;
    });
  };

  const addTogetherRule = () => {
    if (!togetherA || !togetherB || togetherA === togetherB) return;
    const dup = togetherRules.some(
      (r) =>
        (r.a === togetherA && r.b === togetherB) || (r.a === togetherB && r.b === togetherA)
    );
    if (dup) return;
    setTogetherRules((prev) => [...prev, { id: uid("r"), a: togetherA, b: togetherB }]);
    setTogetherA("");
    setTogetherB("");
  };
  const removeTogetherRule = (id) =>
    setTogetherRules((prev) => prev.filter((r) => r.id !== id));
  const nameOf = (id) => displayName(players.find((p) => p.id === id) ?? { name: "?" });

  // ---- sorteio ----
  const runDraw = () => {
    const out = generateDraw(selectedPlayers, numTeams, considerGK, method, effectiveRules());
    if (out.error) {
      setGenError(out.error);
      return;
    }
    setGenError(null);
    setResult(out);
    setJustPublished(false);
    setScreen("result");
  };

  const redoDraw = () => {
    const out = generateDraw(selectedPlayers, numTeams, considerGK, method, effectiveRules());
    if (!out.error) {
      setResult(out);
      setJustPublished(false);
    }
  };

  const shareText = () => {
    if (!result) return "";
    const lines = ["⚽ PELADA 4K - OFICIAL", ""];
    result.teams.forEach((t) => {
      lines.push(`${t.emoji} ${t.label.toUpperCase()}`);
      t.players.forEach((p) => lines.push(displayName(p)));
      lines.push("");
    });
    return lines.join("\n").trim();
  };

  const [shareFallback, setShareFallback] = useState(null);
  const doShare = async () => {
    const text = shareText();
    if (navigator.share) {
      try {
        await navigator.share({ text, title: "Pelada 4K - Oficial" });
        return;
      } catch {
        /* usuário cancelou ou share indisponível — cai no fallback abaixo */
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setToast("Copiado! Cole no WhatsApp.");
    } catch {
      setShareFallback(text);
    }
  };

  const configValid = (() => {
    if (selectedPlayers.length < numTeams) return false;
    if (method === "regras" && ruleConflict) return false;
    return true;
  })();

  if (showTvPage && authUser) {
    return (
      <div className="pelada-root">
        <Styles />
        <TvPage onBack={closeTvPage} isAdmin={isAdmin} />
      </div>
    );
  }

  if (showRulesPage) {
    return (
      <div className="pelada-root">
        <Styles />
        <RulesPage onBack={closeRulesPage} />
      </div>
    );
  }

  if (showPresenceListPage) {
    const nm = nextMondayLabelBRT();
    // Contagem do topo é só o grupo CONFIRMADOS — goleiros têm caixa própria
    // e não entram nessa soma.
    const totalConfirmados = confirmedNonGKs.length + promotedAvulsoEntries.length;
    return (
      <div className="pelada-root">
        <Styles />
        <div className="presence-page">
          <header className="presence-page-header">
            <button className="hero-icon-btn" onClick={closePresenceListPage} aria-label="Voltar">
              ‹
            </button>
            <h1 className="presence-page-title">Lista de Presença</h1>
            <div className="presence-page-date">
              <span className="presence-page-date-icon"><CalendarIcon /></span>
              <span className="presence-page-date-text">
                <span className="presence-page-date-num">{nm.day} {nm.monthAbbr}</span>
                <span className="presence-page-date-day">SEGUNDA</span>
              </span>
            </div>
            {pelada && (
              <button
                type="button"
                className="presence-page-menu-btn"
                onClick={sharePresenceList}
                aria-label="Mais opções"
              >
                ⋮
              </button>
            )}
          </header>

          <div className="presence-page-card">
            <div className="presence-page-card-head">
              <img src={LOGO_DATA_URL} alt="Pelada 4K" className="presence-page-logo" />
              <div className="presence-page-card-headcol">
                <h2 className="presence-page-card-title">PELADA 4K</h2>
                <div className="presence-page-card-info">
                  <div className="presence-page-card-row">
                    <span className="presence-page-card-icon"><CalendarIcon /></span>
                    <span className="presence-page-card-value">SEGUNDA</span>
                  </div>
                  <div className="presence-page-card-row">
                    <span className="presence-page-card-icon"><ClockIcon /></span>
                    <span className="presence-page-card-value">21:00</span>
                  </div>
                  <div className="presence-page-card-row">
                    <span className="presence-page-card-icon"><PinIcon /></span>
                    <span className="presence-page-card-value">Arena Paris - PSG - BH</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {pelada && (
            <div className="presence-page-stats">
              <div className="presence-stat presence-stat-green">
                <div className="presence-stat-top">
                  <PeopleIcon className="presence-stat-icon" />
                  <span className="presence-stat-num">{totalConfirmados}</span>
                </div>
                <span className="presence-stat-label">CONFIRMADOS</span>
              </div>
              <div className="presence-stat presence-stat-yellow">
                <div className="presence-stat-top">
                  <PeopleIcon className="presence-stat-icon" />
                  <span className="presence-stat-num">{waitingAvulsoEntries.length}</span>
                </div>
                <span className="presence-stat-label">AVULSOS</span>
              </div>
              <div className="presence-stat presence-stat-red">
                <div className="presence-stat-top">
                  <PeopleIcon className="presence-stat-icon" />
                  <span className="presence-stat-num">{absentPlayers.length}</span>
                </div>
                <span className="presence-stat-label">AUSENTES</span>
              </div>
            </div>
          )}

          <div className="presence-page-body">
            {pelada ? (
              presenceListInner
            ) : (
              <p className="empty-hint">Nenhuma lista de presença aberta no momento.</p>
            )}
          </div>
        </div>

        {viewPlayer && (
          <ProfileModal
            player={viewPlayer}
            isAdmin={isAdmin}
            canEditOwn={!!myPlayer && viewPlayer.id === myPlayer.id}
            phone={contacts[viewPlayer.id]}
            onClose={() => setViewPlayer(null)}
            onEdit={() => {
              if (isAdmin) {
                setFormPlayer(viewPlayer);
              } else {
                setShowMyProfileForm(true);
              }
              setViewPlayer(null);
            }}
          />
        )}

        {showAccountModal && (
          <AccountModal
            authUser={authUser}
            isAdmin={isAdmin}
            myPlayer={myPlayer}
            onSignIn={handleSignIn}
            onSignUp={handleSignUp}
            onSignOut={handleSignOut}
            onResetPassword={handleResetPassword}
            onClose={() => setShowAccountModal(false)}
            onEditMyProfile={() => {
              setShowMyProfileForm(true);
              setShowAccountModal(false);
            }}
            pelada={pelada}
            amIConfirmed={amIConfirmed}
            amIAbsent={amIAbsent}
            onSetMyPresenceStatus={setMyPresenceStatus}
            onExpressInterest={expressMembershipInterest}
            accessBlocked={myAccessBlocked}
            onShowPaymentAlert={() => setPaymentAlert("mensalista")}
            onSendSuggestion={sendSuggestion}
            onSignedUp={handleSignedUp}
          />
        )}

        {showSetNewPassword && (
          <SetNewPasswordModal
            onSave={handleUpdatePassword}
            onClose={() => setShowSetNewPassword(false)}
          />
        )}

        {showMyProfileForm && myPlayer && (
          <MyProfileForm
            player={myPlayer}
            initialPhone={contacts[myPlayer.id] || ""}
            onSave={saveMyProfile}
            onCancel={() => setShowMyProfileForm(false)}
          />
        )}

        {paymentAlert === "avulso_waiting" && (
          <AvulsoWaitingModal onClose={() => setPaymentAlert(null)} />
        )}
        {paymentAlert === "avulso_promoted_early" && (
          <PromotedEarlyModal onClose={() => setPaymentAlert(null)} />
        )}
        {paymentAlert === "late_rejoin" && (
          <LateRejoinModal onClose={() => setPaymentAlert(null)} />
        )}
        {paymentAlert === "auto_absent" && (
          <AutoAbsentModal
            onClose={() => setPaymentAlert(null)}
            onJoinAvulso={() => {
              setPaymentAlert(null);
              setMyPresenceStatus("confirmed");
            }}
          />
        )}
        {paymentAlert &&
          paymentAlert !== "avulso_waiting" &&
          paymentAlert !== "avulso_promoted_early" &&
          paymentAlert !== "late_rejoin" &&
        paymentAlert !== "auto_absent" && (
            <PaymentAlertModal
            kind={paymentAlert}
            pix={activePix}
            onAlreadyPaid={paymentAlertAlreadyPaid}
            onClose={() => setPaymentAlert(null)}
          />
          )}
      </div>
    );
  }

  if (showExtraPresenceListPage) {
    const extraWhen = peladaExtra?.scheduledFor ? new Date(peladaExtra.scheduledFor) : null;
    const extraDayLabel = extraWhen
      ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" })
          .format(extraWhen)
          .toUpperCase()
      : "A DEFINIR";
    const extraTimeLabel = extraWhen
      ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(
          extraWhen
        )
      : "--:--";
    const totalConfirmadosExtra = confirmedExtraNonGKs.length + confirmedExtraGuests.length;
    return (
      <div className="pelada-root">
        <Styles />
        <div className="presence-page">
          <header className="presence-page-header">
            <button className="hero-icon-btn" onClick={closeExtraPresenceListPage} aria-label="Voltar">
              ‹
            </button>
            <h1 className="presence-page-title">Pelada Extra</h1>
            <div className="presence-page-date">
              <span className="presence-page-date-icon"><CalendarIcon /></span>
              <span className="presence-page-date-text">
                <span className="presence-page-date-num">{extraDayLabel}</span>
                <span className="presence-page-date-day">{extraTimeLabel}</span>
              </span>
            </div>
          </header>

          <div className="presence-page-card">
            <div className="presence-page-card-head">
              <img src={LOGO_DATA_URL} alt="Pelada 4K" className="presence-page-logo" />
              <div className="presence-page-card-headcol">
                <h2 className="presence-page-card-title">PELADA EXTRA</h2>
                <div className="presence-page-card-info">
                  <div className="presence-page-card-row">
                    <span className="presence-page-card-icon"><CalendarIcon /></span>
                    <span className="presence-page-card-value">{extraDayLabel}</span>
                  </div>
                  <div className="presence-page-card-row">
                    <span className="presence-page-card-icon"><ClockIcon /></span>
                    <span className="presence-page-card-value">{extraTimeLabel}</span>
                  </div>
                  <div className="presence-page-card-row">
                    <span className="presence-page-card-icon"><PinIcon /></span>
                    <span className="presence-page-card-value">{peladaExtra?.location || "Local a definir"}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {peladaExtra && (
            <div className="presence-page-stats">
              <div className="presence-stat presence-stat-green">
                <div className="presence-stat-top">
                  <PeopleIcon className="presence-stat-icon" />
                  <span className="presence-stat-num">{totalConfirmadosExtra}</span>
                </div>
                <span className="presence-stat-label">CONFIRMADOS</span>
              </div>
              <div className="presence-stat presence-stat-yellow">
                <div className="presence-stat-top">
                  <PeopleIcon className="presence-stat-icon" />
                  <span className="presence-stat-num">{confirmedExtraGKs.length}</span>
                </div>
                <span className="presence-stat-label">GOLEIROS</span>
              </div>
              <div className="presence-stat presence-stat-red">
                <div className="presence-stat-top">
                  <PeopleIcon className="presence-stat-icon" />
                  <span className="presence-stat-num">{absentExtraPlayers.length}</span>
                </div>
                <span className="presence-stat-label">AUSENTES</span>
              </div>
            </div>
          )}

          <div className="presence-page-body">
            {peladaExtra ? (
              presenceListInnerExtra
            ) : (
              <p className="empty-hint">Nenhuma pelada extra aberta no momento.</p>
            )}
          </div>
        </div>

        {viewPlayer && (
          <ProfileModal
            player={viewPlayer}
            isAdmin={isAdmin}
            canEditOwn={!!myPlayer && viewPlayer.id === myPlayer.id}
            phone={contacts[viewPlayer.id]}
            onClose={() => setViewPlayer(null)}
            onEdit={() => {
              if (isAdmin) {
                setFormPlayer(viewPlayer);
              } else {
                setShowMyProfileForm(true);
              }
              setViewPlayer(null);
            }}
          />
        )}

        {showAccountModal && (
          <AccountModal
            authUser={authUser}
            isAdmin={isAdmin}
            myPlayer={myPlayer}
            onSignIn={handleSignIn}
            onSignUp={handleSignUp}
            onSignOut={handleSignOut}
            onResetPassword={handleResetPassword}
            onClose={() => setShowAccountModal(false)}
            onEditMyProfile={() => {
              setShowMyProfileForm(true);
              setShowAccountModal(false);
            }}
            pelada={peladaExtra}
            amIConfirmed={amIConfirmedExtra}
            amIAbsent={amIAbsentExtra}
            onSetMyPresenceStatus={setMyExtraPresenceStatus}
            onExpressInterest={expressMembershipInterest}
            accessBlocked={false}
            onShowPaymentAlert={() => setPaymentAlert("mensalista")}
            onSendSuggestion={sendSuggestion}
            onSignedUp={handleSignedUp}
          />
        )}

        {showSetNewPassword && (
          <SetNewPasswordModal
            onSave={handleUpdatePassword}
            onClose={() => setShowSetNewPassword(false)}
          />
        )}

        {showMyProfileForm && myPlayer && (
          <MyProfileForm
            player={myPlayer}
            initialPhone={contacts[myPlayer.id] || ""}
            onSave={saveMyProfile}
            onCancel={() => setShowMyProfileForm(false)}
          />
        )}
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="pelada-root">
        <Styles />
        <div className="center-msg">Carregando…</div>
      </div>
    );
  }

  return (
    <div className="pelada-root">
      <Styles />

      <div className="stadium-bg" aria-hidden="true">
        <div ref={skyRef} className="stadium-photo" />
        <div ref={glowRef} className="stadium-glow" />
        {screen !== "roster" && (
          <img ref={logoRef} src={LOGO_DATA_URL} alt="" className="floating-logo" />
        )}
        <div className="stadium-vignette" />
      </div>

      <div className="pelada-content">
      <header className="topbar">
        <button
          className="admin-gear-btn"
          onClick={() => setShowAccountModal(true)}
          aria-label="Minha conta"
        >
          {isAdmin ? emo("🔓") : authUser ? emo("👤") : emo("⚙")}
        </button>
        <button
          type="button"
          className="logo-crest-btn"
          onClick={() => {
            window.location.reload();
          }}
          aria-label="Ir para o início e recarregar a página"
        >
          <img src={LOGO_DATA_URL} alt="Pelada" className="logo-crest" />
        </button>
        <div className="topbar-flare" aria-hidden="true" />
        <span className="topbar-flare-reflex" aria-hidden="true" />
        <span className="topbar-caption">PELADA 4K OFICIAL</span>
        <span className="topbar-season">TEMPORADA 2026</span>
      </header>

      {toast && <div className="toast">{toast}</div>}

      {/* ---------------- ROSTER ---------------- */}
      {screen === "roster" && (
        <main className="screen">
          <StoriesRow
            storiesByPlayer={storiesByPlayer}
            orderedPlayerIds={storyPlayerIds}
            players={players}
            myPlayer={myPlayer}
            seenStoryIds={seenStoryIds}
            uploading={uploadingStory}
            onOpenViewer={(playerId) => setStoryViewerPlayerId(playerId)}
            onAddClick={() => setShowStorySourceSheet(true)}
          />
          <input
            ref={storyGalleryFileRef}
            type="file"
            accept="image/*,video/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) uploadStory(file);
            }}
          />
          <input
            ref={storyPhotoCameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) uploadStory(file);
            }}
          />
          <input
            ref={storyVideoCameraRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) uploadStory(file);
            }}
          />
          {showStorySourceSheet && (
            <div className="modal-backdrop" onClick={() => setShowStorySourceSheet(false)}>
              <div className="modal story-source-sheet" onClick={(e) => e.stopPropagation()}>
                <h2 className="modal-title">Novo story</h2>
                <button
                  type="button"
                  className="story-source-option"
                  onClick={() => {
                    setShowStorySourceSheet(false);
                    storyPhotoCameraRef.current?.click();
                  }}
                >
                  <Emo e="📷" /> Tirar foto
                </button>
                <button
                  type="button"
                  className="story-source-option"
                  onClick={() => {
                    setShowStorySourceSheet(false);
                    if (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) {
                      setShowStoryCamera(true);
                    } else {
                      storyVideoCameraRef.current?.click();
                    }
                  }}
                >
                  <Emo e="🎥" /> Gravar vídeo
                </button>
                <button
                  type="button"
                  className="story-source-option"
                  onClick={() => {
                    setShowStorySourceSheet(false);
                    storyGalleryFileRef.current?.click();
                  }}
                >
                  <Emo e="🖼️" /> Escolher da galeria
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-block"
                  onClick={() => setShowStorySourceSheet(false)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {showStoryCamera && (
            <StoryCameraModal
              onClose={() => setShowStoryCamera(false)}
              onCapture={(blob) => {
                setShowStoryCamera(false);
                uploadStory(blob);
              }}
            />
          )}
          {storyViewerPlayerId && (
            <StoryViewerModal
              orderedPlayerIds={
                myPlayer && storiesByPlayer[myPlayer.id]
                  ? [myPlayer.id, ...storyPlayerIds.filter((id) => id !== myPlayer.id)]
                  : storyPlayerIds
              }
              storiesByPlayer={storiesByPlayer}
              players={players}
              startPlayerId={storyViewerPlayerId}
              isAdmin={isAdmin}
              myPlayerId={myPlayer?.id ?? null}
              onClose={() => setStoryViewerPlayerId(null)}
              onSeen={markStorySeen}
              onDelete={async (id) => {
                if (!window.confirm("Excluir este story?")) return;
                await deleteStory(id);
                setStoryViewerPlayerId(null);
              }}
              authUser={authUser}
              onRecordView={recordStoryView}
              onToggleLike={toggleStoryLike}
              onReact={sendStoryReaction}
              onFetchMyInteraction={fetchMyStoryInteraction}
              onFetchViewers={fetchStoryViewers}
            />
          )}

          <div className="member-search">
            <div className="member-search-box">
              <span className="member-search-icon"><Emo e="🔍" /></span>
              <input
                className="member-search-input"
                type="text"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                onFocus={() => setMemberSearchFocused(true)}
                onBlur={() => setTimeout(() => setMemberSearchFocused(false), 150)}
                placeholder="Buscar membro pelo nome ou apelido..."
              />
              {memberSearch && (
                <button
                  type="button"
                  className="member-search-clear"
                  onClick={() => setMemberSearch("")}
                  aria-label="Limpar busca"
                >
                  ×
                </button>
              )}
            </div>
            {memberSearchFocused && memberSearch.trim() && (
              <div className="member-search-suggestions">
                {(() => {
                  const q = memberSearch.trim().toLowerCase();
                  const matches = players
                    .filter(
                      (p) =>
                        displayName(p).toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
                    )
                    .slice(0, 8);
                  if (!matches.length) {
                    return <div className="member-search-empty">Nenhum membro encontrado.</div>;
                  }
                  return matches.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="member-search-item"
                      onClick={() => {
                        setViewPlayer(p);
                        setMemberSearch("");
                        setMemberSearchFocused(false);
                      }}
                    >
                      <Avatar player={p} shape="round" size={34} />
                      <span className="member-search-item-text">
                        <span className="member-search-item-name">{displayName(p)}</span>
                        {p.nickname && <span className="member-search-item-fullname">{p.name}</span>}
                      </span>
                    </button>
                  ));
                })()}
              </div>
            )}
          </div>

          {loadError && (
            <p className="error-text">
              Não foi possível carregar o elenco. Verifique sua conexão e recarregue a página.
            </p>
          )}

          {isAdmin && (
            <AdminToolbar
              hasPelada={!!pelada}
              onPublishPelada={() => setShowPublishPelada(true)}
              hasPeladaExtra={!!peladaExtra}
              onPublishPeladaExtra={() => setShowPublishPeladaExtra(true)}
              onDeletePeladaExtra={() => {
                if (window.confirm("Excluir a pelada extra? Dá pra reabrir depois em Histórico.")) {
                  deletePelada("extra");
                }
              }}
              onHistory={openHistory}
              onInterestList={() => setShowInterestList(true)}
              interestCount={membershipInterestList.length}
              onMensalistaControl={() => setShowMensalistaControl(true)}
              mensalistaCount={mensalistaList.length}
              onPaymentControl={() => setShowPaymentControl(true)}
              onAdminControl={() => setShowAdminControl(true)}
              onStopwatch={() => { sw.actions.publish(); setShowStopwatch(true); }}
              onAnnouncement={() => setShowAnnouncementAdmin(true)}
              onFinance={openFinance}
              onSuggestions={openSuggestions}
              suggestionsCount={suggestionsUnreadCount}
              onSorteio={() => {
                if (players.length < 4) {
                  setToast("Cadastre pelo menos 4 jogadores para começar.");
                  return;
                }
                if (confirmedPlayers.length > 0) pullPresenceIntoSelection();
                else setSelectedIds(new Set());
                goToSelect();
              }}
              onDeletePelada={() => {
                if (window.confirm("Excluir esta lista de presença? Dá pra reabrir depois em Histórico.")) {
                  deletePelada("main");
                }
              }}
            />
          )}
          {isAdmin && (
            <p className="field-hint admin-toolbar-hint">
              A lista da próxima pelada é publicada automaticamente toda sexta-feira as 12h.
              Mensalistas tem prioridade na lista até 13h de segunda-feira. Após 13h, a lista
              se torna geral.
            </p>
          )}

          {pelada && !escalacaoIsCurrent && (
            <PresenceOpenBanner onOpen={openPresenceListPage} />
          )}

          {peladaExtra && (
            <PresenceOpenBanner
              onOpen={openExtraPresenceListPage}
              title="LISTA - PELADA EXTRA"
              cta="ACESSE AQUI"
              className="extra-banner"
            />
          )}

          {presenceShareFallback && (
            <div className="modal-backdrop" onClick={() => setPresenceShareFallback(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2 className="modal-title">Copiar para o WhatsApp</h2>
                <textarea
                  className="input share-textarea"
                  readOnly
                  value={presenceShareFallback}
                  onFocus={(e) => e.target.select()}
                />
                <div className="modal-actions">
                  <button className="btn btn-primary btn-block" onClick={() => setPresenceShareFallback(null)}>
                    Fechar
                  </button>
                </div>
              </div>
            </div>
          )}

          {myMensalidadeDue && !myMembershipPaid && (
            <button
              type="button"
              className={`mensalidade-cta-btn ${myReportedPaid ? "is-reported" : ""}`}
              onClick={() => setPaymentAlert("mensalista")}
            >
              <span className="mensalidade-cta-title"><Emo e="💰" /> PAGAMENTO MENSALIDADE</span>
              <span className="mensalidade-cta-sub">
                {myReportedPaid
                  ? emo("✔ Você informou que já pagou — aguardando confirmação de um admin")
                  : `${monthKeyLabel(currentMonthKey())} · toque pra ver o PIX`}
              </span>
            </button>
          )}

          {escalacaoIsCurrent && (isBeforeWednesday8pmBRT() || isEscalacaoFreshBRT(publishedList?.updatedAt)) && (
            <EscalacaoBanner
              onOpen={() => setShowEscalacaoModal(true)}
              concluded={isEscalacaoConcludedBRT()}
            />
          )}

          {authUser && swBannerOn && <StopwatchBanner sw={sw} push={swPush} onOpen={() => setShowStopwatch(true)} />}
          {authUser && showStopwatch && <StopwatchModal sw={sw} push={swPush} isAdmin={isAdmin} onClose={() => setShowStopwatch(false)} />}

          {showEscalacaoModal && publishedList && (
            <EscalacaoModal
              list={publishedList}
              isAdmin={isAdmin}
              hasPelada={!!pelada}
              onClose={() => setShowEscalacaoModal(false)}
              onSeePresence={() => {
                setShowEscalacaoModal(false);
                setShowPresenceListModal(true);
              }}
              onUnpublish={() => {
                unpublishList();
                setShowEscalacaoModal(false);
              }}
              onViewPlayer={(p) => setViewPlayer(p)}
            />
          )}

          {showPresenceListModal && pelada && (
            <div className="modal-backdrop" onClick={() => setShowPresenceListModal(false)}>
              <div className="modal presence-list-modal" onClick={(e) => e.stopPropagation()}>
                <h2 className="modal-title"><Emo e="📋" /> Lista de presença · Pelada 4K</h2>
                {presenceListInner}
                <div className="modal-actions">
                  <button className="btn btn-ghost btn-block" onClick={() => setShowPresenceListModal(false)}>
                    Fechar
                  </button>
                </div>
              </div>
            </div>
          )}

          {players.some((p) => p.cover1 || p.cover2 || p.cover3 || p.cover4 || p.cover5) && (
            <div className="sec-title"><span><Emo e="⭐" />DESTAQUES</span></div>
          )}
          <FeaturedCards players={players} onViewPlayer={setViewPlayer} />

          <button className="btn btn-ghost btn-block" onClick={openRulesPage}>
            <Emo e="📖" /> REGRAS DA PELADA 4K
          </button>

          {authUser && (
            <button className="btn btn-ghost btn-block tv-open-btn" onClick={openTvPage}>
              <Emo e="📺" /> TV PELADA 4K
            </button>
          )}

          {isAdmin && (
            <button className="btn btn-ghost btn-block" onClick={() => setFormPlayer(null)}>
              + Adicionar jogador
            </button>
          )}

          {players.length === 0 ? (
            <p className="empty-hint">
              {isAdmin
                ? "Cadastre os jogadores que costumam jogar. Depois é só marcar quem apareceu e sortear os times."
                : "Ainda não há jogadores cadastrados. Peça para um administrador cadastrar o elenco."}
            </p>
          ) : (
            <><div className="sec-title"><span><Emo e="⚽" />ELENCO</span></div>
            <ul className="roster-list">
              {rosterDisplayList.map((p) => (
                <li key={p.id} className="roster-row" onClick={() => setViewPlayer(p)}>
                  <div className="roster-row-main">
                    <Avatar player={p} shape="round" size={58} />
                    <div className="roster-info">
                      <span className="roster-name">{displayName(p)}</span>
                      {p.nickname && <span className="roster-fullname">{p.name}</span>}
                      <span className="roster-sub">
                        {p.position || "Sem posição definida"}
                      </span>
                      {p.instagram && <InstagramLink handle={p.instagram} className="roster-instagram" />}
                      <MembershipBadge player={p} className="membership-badge-roster" short />
                    </div>
                    <div className={`rating-badge rb-${p.isGK ? "bord" : isMensalista(p) ? "gold" : "silver"}`}>
                      <span className="rating-badge-num">{p.rating}</span>
                      <span className="rating-badge-label"><PosTag p={p} /></span>
                    </div>
                  </div>
                  {(isAdmin || (myPlayer && myPlayer.id === p.id)) && (
                    <div className="roster-row-footer">
                      <button
                        className="roster-edit-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isAdmin) setFormPlayer(p);
                          else setShowMyProfileForm(true);
                        }}
                        aria-label={`Editar ${p.name}`}
                      >
                        editar
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul></>
          )}

          {!isAdmin && (
            <button
              className="btn btn-ghost btn-block interest-cta-btn"
              onClick={() => setShowPublicInterestList(true)}
            >
              <Emo e="🏅" /> Interesse Mensalista
              {membershipInterestList.length > 0 && (
                <span className="count-pill">{membershipInterestList.length}</span>
              )}
            </button>
          )}

        </main>
      )}

      {/* ---------------- SELECT ---------------- */}
      {screen === "select" && (
        <main className="screen">
          <button className="back-link" onClick={() => setScreen("roster")}>
            ← Jogadores
          </button>
          <StepDots step={1} />
          <div className="screen-head">
            <h1>Quem vai jogar?</h1>
          </div>
          <div className="select-toolbar">
            <span className="count-pill count-pill-lg">
              {selectedIds.size} selecionado{selectedIds.size === 1 ? "" : "s"}
            </span>
            <div className="select-links">
              {confirmedPlayers.length > 0 && (
                <button className="link" onClick={pullPresenceIntoSelection}>
                  <Emo e="🔔" /> Puxar lista de presença
                </button>
              )}
              <button className="link" onClick={() => setSelectedIds(new Set(players.map((p) => p.id)))}>
                Selecionar todos
              </button>
              <button className="link" onClick={() => setSelectedIds(new Set())}>
                Limpar
              </button>
            </div>
          </div>

          <ul className="select-grid">
            {alphabeticalPlayers.map((p) => {
              const on = selectedIds.has(p.id);
              return (
                <li
                  key={p.id}
                  className={`select-card ${on ? "select-card-on" : ""}`}
                  onClick={() => toggleSelect(p.id)}
                >
                  <Avatar player={p} shape="square" size={56} />
                  <div className="select-card-info">
                    <span className="select-card-name">{displayName(p)}</span>
                    {p.nickname && <span className="select-card-fullname">{p.name}</span>}
                    <span className="select-card-sub">
                      {p.position || "—"}
                    </span>
                  </div>
                  <span className="select-card-rating">{p.rating}</span>
                  <span className={`check ${on ? "check-on" : ""}`}>{on ? emo("✓") : ""}</span>
                </li>
              );
            })}
          </ul>

          <div className="bottom-bar">
            <button
              className="btn btn-primary btn-block"
              disabled={selectedIds.size < 4}
              onClick={goToConfig}
            >
              Continuar
            </button>
            {selectedIds.size > 0 && selectedIds.size < 4 && (
              <p className="bottom-hint">Selecione pelo menos 4 jogadores.</p>
            )}
          </div>
        </main>
      )}

      {/* ---------------- CONFIG ---------------- */}
      {screen === "config" && (
        <main className="screen">
          <button className="back-link" onClick={() => setScreen("select")}>
            ← Seleção
          </button>
          <StepDots step={2} />
          <div className="screen-head">
            <h1>Configuração</h1>
          </div>

          <section className="config-block">
            <h2 className="config-title">Quantos times?</h2>
            <div className="segmented">
              {[2, 3].map((n) => (
                <button
                  key={n}
                  className={`segmented-opt ${numTeams === n ? "segmented-opt-on" : ""}`}
                  onClick={() => setNumTeams(n)}
                  disabled={selectedPlayers.length < n}
                >
                  {n} Times
                </button>
              ))}
            </div>
            <p className="config-hint">
              {computeTeamSizes(selectedPlayers.length, numTeams).join(" + ")} jogadores por time
            </p>
          </section>

          <section className="config-block">
            <h2 className="config-title"><Emo e="🧤" /> Considerar goleiros?</h2>
            <div className="segmented">
              <button
                className={`segmented-opt ${considerGK ? "segmented-opt-on" : ""}`}
                onClick={() => setConsiderGK(true)}
              >
                Sim
              </button>
              <button
                className={`segmented-opt ${!considerGK ? "segmented-opt-on" : ""}`}
                onClick={() => setConsiderGK(false)}
              >
                Não
              </button>
            </div>
            <p className="config-hint">
              {selectedGKCount} goleiro{selectedGKCount === 1 ? "" : "s"} entre os selecionados
            </p>
          </section>

          <section className="config-block">
            <h2 className="config-title">Método de sorteio</h2>
            <div className="method-list">
              <button
                className={`method-card ${method === "aleatorio" ? "method-card-on" : ""}`}
                onClick={() => setMethod("aleatorio")}
              >
                <span className="method-icon"><Emo e="🎲" /></span>
                <span>
                  <span className="method-name">Aleatório</span>
                  <span className="method-desc">Todos com a mesma chance</span>
                </span>
              </button>
              <button
                className={`method-card ${method === "qualidade" ? "method-card-on" : ""}`}
                onClick={() => setMethod("qualidade")}
              >
                <span className="method-icon"><Emo e="⭐" /></span>
                <span>
                  <span className="method-name">Por qualidade</span>
                  <span className="method-desc">Times com força equilibrada</span>
                </span>
              </button>
              <button
                className={`method-card ${method === "regras" ? "method-card-on" : ""}`}
                onClick={() => setMethod("regras")}
              >
                <span className="method-icon"><Emo e="📋" /></span>
                <span>
                  <span className="method-name">Regras</span>
                  <span className="method-desc">Separar ou manter jogadores juntos</span>
                </span>
              </button>
            </div>
          </section>

          {method === "regras" && (
            <section className="config-block">
              <h2 className="config-title">Regras</h2>

              <p className="rules-section-label"><Emo e="🚫" /> Separar (nunca no mesmo time)</p>
              {separateGroups.map((group, gi) => (
                <div className="separate-group-box" key={gi}>
                  <span className="separate-group-title">Grupo {gi + 1}</span>
                  <div className="separate-group-slots">
                    {group.map((val, si) => (
                      <select
                        key={si}
                        className="input"
                        value={val}
                        onChange={(e) => setGroupSlot(gi, si, e.target.value)}
                      >
                        <option value="">Jogador {si + 1}</option>
                        {selectedPlayers.map((p) => (
                          <option
                            key={p.id}
                            value={p.id}
                            disabled={group.includes(p.id) && group[si] !== p.id}
                          >
                            {displayName(p)}
                          </option>
                        ))}
                      </select>
                    ))}
                  </div>
                  <p className="separate-group-hint">
                    Ninguém deste grupo pode ficar no mesmo time.
                  </p>
                </div>
              ))}

              <p className="rules-section-label rules-section-label-spaced"><Emo e="🤝" /> Manter juntos</p>
              <div className="rule-builder">
                <div className="rule-pickers">
                  <select className="input" value={togetherA} onChange={(e) => setTogetherA(e.target.value)}>
                    <option value="">Jogador A</option>
                    {selectedPlayers.map((p) => (
                      <option key={p.id} value={p.id} disabled={p.id === togetherB}>
                        {displayName(p)}
                      </option>
                    ))}
                  </select>
                  <span className="rule-symbol"><Emo e="🤝" /></span>
                  <select className="input" value={togetherB} onChange={(e) => setTogetherB(e.target.value)}>
                    <option value="">Jogador B</option>
                    {selectedPlayers.map((p) => (
                      <option key={p.id} value={p.id} disabled={p.id === togetherA}>
                        {displayName(p)}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  className="btn btn-ghost btn-block btn-sm"
                  disabled={!togetherA || !togetherB || togetherA === togetherB}
                  onClick={addTogetherRule}
                >
                  Adicionar regra
                </button>
              </div>

              {togetherRules.length > 0 && (
                <ul className="rule-list">
                  {togetherRules.map((r) => (
                    <li key={r.id} className="rule-row">
                      <span>
                        {nameOf(r.a)} <Emo e="🤝" /> {nameOf(r.b)}
                      </span>
                      <button className="link link-danger" onClick={() => removeTogetherRule(r.id)}>
                        remover
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {ruleConflict && (
                <p className="error-text">
                  Existem regras conflitantes. Revise suas regras antes de sortear.
                </p>
              )}
            </section>
          )}

          {genError && <p className="error-text">{genError}</p>}

          <div className="bottom-bar">
            <button className="btn btn-primary btn-block" disabled={!configValid} onClick={runDraw}>
              <Emo e="🎲" /> Sortear Times
            </button>
          </div>
        </main>
      )}

      {/* ---------------- RESULT ---------------- */}
      {screen === "result" && result && (
        <main className="screen">
          <button
            className="back-link"
            onClick={() => {
              setScreen("roster");
              setResult(null);
            }}
          >
            ← Início
          </button>
          <button className="back-link back-link-secondary" onClick={() => setScreen("config")}>
            ← Voltar pra regras
          </button>
          <StepDots step={3} />
          <div className="screen-head">
            <h1>Times Definidos <Emo e="⚽" /></h1>
          </div>

          {result.gkMessage && <div className="info-banner">{result.gkMessage}</div>}

          {result.teams.map((t) => (
            <section key={t.key} className="team-card" style={{ "--team-color": t.color }}>
              <div className="team-card-head">
                <span className="team-card-title">
                  {emo(t.emoji)} {t.label.toUpperCase()}
                </span>
              </div>
              <ul className="team-player-list">
                {t.players.map((p) => (
                  <li key={p.id} className="team-player-row">
                    <Avatar player={p} shape="square" size={46} />
                    <span className="team-player-name">
                      {displayName(p)} {result.considerGK && p.isGK ? emo("🧤") : ""}
                    </span>
                    <Stars count={starsFilled(p.rating)} />
                  </li>
                ))}
              </ul>
              <div className="team-card-foot">Força: {t.sum}</div>
            </section>
          ))}

          <section className="balance-card">
            <h2 className="config-title"><Emo e="⚖️" /> Equilíbrio</h2>
            <Stars count={result.stars} />
            <p className="balance-label">{result.label}</p>
            <p className="balance-detail">
              {result.teams.map((t) => `${t.label.replace("Time ", "")}: ${t.sum}`).join(" · ")}
            </p>
            <p className="balance-detail">
              Diferença máxima: <strong>{result.diff} ponto{result.diff === 1 ? "" : "s"}</strong>
            </p>
          </section>

          <div className="result-actions">
            <button className="btn btn-ghost btn-block" onClick={redoDraw}>
              <Emo e="🎲" /> Refazer Sorteio
            </button>
            <button className="btn btn-primary btn-block" onClick={doShare}>
              <Emo e="📲" /> Compartilhar
            </button>
          </div>

          {isAdmin && (
            <>
              <button className="btn btn-primary btn-block publish-btn" onClick={publishList}>
                {justPublished ? emo("✓ Lista publicada") : emo("📋 Publicar Lista")}
              </button>
              <p className="field-hint publish-hint">
                Publicar deixa essa lista visível pra todo mundo na página inicial, em "Lista Próxima Pelada".
              </p>
            </>
          )}

          {shareFallback && (
            <div className="modal-backdrop" onClick={() => setShareFallback(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2 className="modal-title">Copiar para o WhatsApp</h2>
                <textarea className="input share-textarea" readOnly value={shareFallback} onFocus={(e) => e.target.select()} />
                <div className="modal-actions">
                  <button className="btn btn-primary btn-block" onClick={() => setShareFallback(null)}>
                    Fechar
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {viewPlayer && (
        <ProfileModal
          player={viewPlayer}
          isAdmin={isAdmin}
          canEditOwn={!!myPlayer && viewPlayer.id === myPlayer.id}
          phone={contacts[viewPlayer.id]}
          onClose={() => setViewPlayer(null)}
          onEdit={() => {
            if (isAdmin) {
              setFormPlayer(viewPlayer);
            } else {
              setShowMyProfileForm(true);
            }
            setViewPlayer(null);
          }}
        />
      )}

      {showSignupLinkAlert && (
        <SignupLinkAlertModal onClose={() => setShowSignupLinkAlert(false)} />
      )}

      {showWelcomeModal && myPlayer && (
        <WelcomeModal
          playerName={displayName(myPlayer)}
          onClose={() => setShowWelcomeModal(false)}
          onReadRules={() => {
            setShowWelcomeModal(false);
            openRulesPage();
          }}
        />
      )}

      {showAccountModal && (
        <AccountModal
          authUser={authUser}
          isAdmin={isAdmin}
          myPlayer={myPlayer}
          onSignIn={handleSignIn}
          onSignUp={handleSignUp}
          onSignOut={handleSignOut}
          onResetPassword={handleResetPassword}
          onClose={() => setShowAccountModal(false)}
          onEditMyProfile={() => {
            setShowMyProfileForm(true);
            setShowAccountModal(false);
          }}
          pelada={pelada}
          amIConfirmed={amIConfirmed}
          amIAbsent={amIAbsent}
          onSetMyPresenceStatus={setMyPresenceStatus}
          onExpressInterest={expressMembershipInterest}
          accessBlocked={myAccessBlocked}
          onShowPaymentAlert={() => setPaymentAlert("mensalista")}
          onSendSuggestion={sendSuggestion}
          onSignedUp={handleSignedUp}
        />
      )}

      {showSetNewPassword && (
        <SetNewPasswordModal
          onSave={handleUpdatePassword}
          onClose={() => setShowSetNewPassword(false)}
        />
      )}

      {showMyProfileForm && myPlayer && (
        <MyProfileForm
          player={myPlayer}
          initialPhone={contacts[myPlayer.id] || ""}
          onSave={saveMyProfile}
          onCancel={() => setShowMyProfileForm(false)}
        />
      )}

      {showPublishPelada && (
        <PublishPeladaModal
          onPublish={publishPelada}
          onClose={() => setShowPublishPelada(false)}
        />
      )}

      {showPublishPeladaExtra && (
        <PublishPeladaModal
          title="Publicar pelada extra"
          hint="Lista avulsa, fora do cronograma semanal — não mexe na pelada principal. É livre: qualquer jogador cadastrado confirma direto, sem fila nem mensalidade."
          onPublish={(fields) => publishPelada({ ...fields, kind: "extra" })}
          onClose={() => setShowPublishPeladaExtra(false)}
        />
      )}

      {showHistory && (
        <PresenceHistoryModal
          history={history}
          loading={historyLoading}
          players={players}
          onClose={() => setShowHistory(false)}
          onReopen={reopenPelada}
        />
      )}

      {showInterestList && (
        <MembershipInterestModal
          list={interestQueue}
          tempInfo={tempInterestInfo}
          availableToAdd={interestAvailableToAdd}
          addedByName={interestAddedByName}
          onAdd={adminMarkInterest}
          onApprove={(id) => setPlayerMembership(id, "mensalista")}
          onDismiss={dismissMembershipInterest}
          onMoveUp={(id) => reorderMembershipInterest(id, "up")}
          onMoveDown={(id) => reorderMembershipInterest(id, "down")}
          onClose={() => setShowInterestList(false)}
        />
      )}

      {showPublicInterestList && (
        <PublicInterestModal
          list={interestQueue}
          tempInfo={tempInterestInfo}
          addedByName={isAdmin ? interestAddedByName : null}
          availableToAdd={interestAvailableToAdd}
          onAdd={isAdmin ? adminMarkInterest : null}
          canRequest={!isAdmin && !!myPlayer && !isMensalista(myPlayer)}
          alreadyRequested={!!myPlayer?.membershipInterestAt}
          onRequest={expressMembershipInterest}
          onClose={() => setShowPublicInterestList(false)}
        />
      )}

      {paymentAlert === "avulso_waiting" && (
        <AvulsoWaitingModal onClose={() => setPaymentAlert(null)} />
      )}
      {paymentAlert === "avulso_promoted_early" && (
        <PromotedEarlyModal onClose={() => setPaymentAlert(null)} />
      )}
      {paymentAlert === "late_rejoin" && (
        <LateRejoinModal onClose={() => setPaymentAlert(null)} />
      )}
      {paymentAlert === "auto_absent" && (
        <AutoAbsentModal
          onClose={() => setPaymentAlert(null)}
          onJoinAvulso={() => {
            setPaymentAlert(null);
            setMyPresenceStatus("confirmed");
          }}
        />
      )}
      {paymentAlert &&
        paymentAlert !== "avulso_waiting" &&
        paymentAlert !== "avulso_promoted_early" &&
        paymentAlert !== "late_rejoin" &&
        paymentAlert !== "auto_absent" && (
          <PaymentAlertModal
            kind={paymentAlert}
            pix={activePix}
            onAlreadyPaid={paymentAlertAlreadyPaid}
            onClose={() => setPaymentAlert(null)}
          />
        )}

      {showPaymentControl && (
        <PaymentControlModal
          monthLabel={monthKeyLabel(currentMonthKey())}
          mensalistas={payableMensalistaList}
          membershipPayments={membershipPayments}
          onToggleMensalistaPaid={setMensalistaPaid}
          blockUnpaidEnabled={blockUnpaidEnabled}
          onToggleBlockUnpaid={toggleBlockUnpaid}
          avulsoEntries={promotedAvulsoEntries}
          hasPelada={!!pelada}
          onToggleAvulsoPaid={setPresencePaid}
          replacedNameFor={replacedNameFor}
          pixSettings={pixSettings}
          onSavePixSettings={savePixSettings}
          adminProfiles={profiles.filter((pr) => adminUserIds.has(pr.id))}
          myUserId={authUser?.id}
          onClose={() => setShowPaymentControl(false)}
        />
      )}

      {showAdminControl && (
        <AdminControlModal
          profiles={profiles}
          adminUserIds={adminUserIds}
          myUserId={authUser?.id}
          onGrant={grantAdmin}
          onRevoke={revokeAdmin}
          onClose={() => setShowAdminControl(false)}
        />
      )}

      {showMensalistaControl && (
        <MensalistaControlModal
          mensalistas={mensalistaList}
          interestList={membershipInterestList}
          availableToPromote={nonMensalistaPlayers}
          replacedNameFor={replacedNameFor}
          onDemote={(id) => setPlayerMembership(id, "avulso")}
          onReplace={replaceMensalista}
          onMakeTemp={makeTempMensalista}
          onPromote={(id) => setPlayerMembership(id, "mensalista")}
          onRestoreOriginal={restoreOriginalMensalista}
          onEndTemp={endTempMensalista}
          onMakeTempPermanent={makeTempPermanent}
          onClose={() => setShowMensalistaControl(false)}
        />
      )}

      {showFinance && (
        <FinanceControlModal
          loading={financeLoading}
          mensalidades={financeData.mensalidades}
          avulsos={financeData.avulsos}
          expenses={financeData.expenses}
          peladas={financeData.peladas}
          onMoveIncome={moveFinanceIncome}
          pixSettings={pixSettings}
          onSetMonthCaixa={(id) => savePixSettings({ accounts: pixAccountsOf(pixSettings), activeId: id })}
          onRefundIncome={refundFinanceIncome}
          players={players}
          adminProfiles={profiles.filter((pr) => adminUserIds.has(pr.id))}
          myUserId={authUser?.id}
          onAddExpense={addCashExpense}
          onDeleteExpense={deleteCashExpense}
          onClose={() => setShowFinance(false)}
        />
      )}

      {showAnnouncementPopup && announcement && (
        <AnnouncementPopup
          announcement={announcement}
          onClose={() => {
            dismissAnnouncement(announcement);
            setShowAnnouncementPopup(false);
          }}
        />
      )}

      {showAnnouncementAdmin && (
        <AdminAnnouncementModal
          current={announcement}
          onPublish={publishAnnouncement}
          onClear={clearAnnouncement}
          onClose={() => setShowAnnouncementAdmin(false)}
        />
      )}

      {showSuggestions && (
        <SuggestionsModal
          suggestions={suggestions}
          loading={suggestionsLoading}
          onDelete={deleteSuggestion}
          onClose={() => setShowSuggestions(false)}
        />
      )}

      {formPlayer !== undefined && (
        <PlayerForm
          player={formPlayer}
          onSave={savePlayer}
          onCancel={() => setFormPlayer(undefined)}
          onDelete={deletePlayer}
          linkableProfiles={
            isAdmin
              ? profiles.filter((pr) => !players.some((pl) => pl.userId === pr.id))
              : null
          }
          linkedProfile={
            formPlayer ? profiles.find((pr) => pr.id === formPlayer.userId) ?? null : null
          }
          onLinkUser={linkUserToPlayer}
          initialPhone={formPlayer ? contacts[formPlayer.id] || "" : ""}
        />
      )}

      <footer className="app-footer">App criado e desenvolvido por Philippe Norman</footer>
      </div>
    </div>
  );
}

/* =========================================================================
   CRONÔMETRO — placar eletrônico de estádio (7 min decrescentes por padrão)
   ========================================================================= */
const SEG_ON = {
  0: "abcdef", 1: "bc", 2: "abged", 3: "abgcd", 4: "fgbc", 5: "afgcd", 6: "afgedc", 7: "abc", 8: "abcdefg", 9: "abcdfg",
};
const SEG_POLY = {
  a: "12,5 48,5 42,13 18,13", b: "57,9 49,17 49,44 57,48", c: "57,52 49,56 49,83 57,91",
  d: "12,95 48,95 42,87 18,87", e: "3,52 11,56 11,83 3,91", f: "3,9 11,17 11,44 3,48",
  g: "10,50 17,44 43,44 50,50 43,56 17,56",
};
function SevenSeg({ n }) {
  const on = SEG_ON[n] || "";
  return (
    <svg className="sb-digit" viewBox="0 0 60 100" aria-hidden="true">
      {Object.keys(SEG_POLY).map((k) => (
        <polygon key={k} points={SEG_POLY[k]} className={on.includes(k) ? "sb-seg sb-on" : "sb-seg"} />
      ))}
    </svg>
  );
}
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || "BMDVtskGZdjJ0_Xb6IF9_KYDsm3TvflDgriw4Fog6YlZnvgu7JRo3VW-64098VYQZqNEfDpJtjZxEGvIdqc0MYs";
const b64ToU8 = (b) => {
  const pad = "=".repeat((4 - (b.length % 4)) % 4);
  const raw = atob((b + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const isIOSDevice = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalonePWA = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;

// Aviso push (app fechado). status: "unsupported" | "needs-install" | "denied" | "off" | "on"
function usePushAlert(authUser) {
  const [status, setStatus] = useState("off");
  const [busy, setBusy] = useState(false);
  const enableRef = useRef(null);
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  useEffect(() => {
    if (!authUser) return;
    if (!supported) { setStatus(isIOSDevice() && !isStandalonePWA() ? "needs-install" : "unsupported"); return; }
    if (Notification.permission === "denied") { setStatus("denied"); return; }
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((sub) => {
      if (sub && Notification.permission === "granted") { setStatus("on"); return; }
      setStatus("off");
      if (Notification.permission === "granted") enableRef.current?.(); // já autorizado: registra sem perguntar
    }).catch(() => {});
  }, [authUser?.id, supported]); // eslint-disable-line react-hooks/exhaustive-deps
  const enable = async () => {
    if (busy || status === "on" || !supported) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setStatus(perm === "denied" ? "denied" : "off"); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC_KEY) }));
      const j = sub.toJSON();
      const { error } = await supabase.from("push_subscriptions").upsert({ user_id: authUser.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
      setStatus(error ? "off" : "on");
    } catch { setStatus("off"); } finally { setBusy(false); }
  };
  enableRef.current = enable;
  const disable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
      setStatus("off");
    } catch {} finally { setBusy(false); }
  };
  return { status, busy, enable, disable };
}

// Cronômetro aparece sozinho nas segundas, das 21h às 23h30 (Brasília).
const brtNowParts = (now = new Date()) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short", hour: "numeric", minute: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t) => f.find((x) => x.type === t)?.value;
  return { weekday: g("weekday"), hour: Number(g("hour")) % 24, minute: Number(g("minute")), date: `${g("year")}-${g("month")}-${g("day")}` };
};
const isStopwatchWindowBRT = (now = new Date()) => {
  const b = brtNowParts(now);
  const mins = b.hour * 60 + b.minute;
  return b.weekday === "Mon" && mins >= 21 * 60 && mins < 23 * 60 + 30;
};
const todayBRT = (now = new Date()) => brtNowParts(now).date;

// Presença nas peladas concluídas (vem do banco: attendance_stats) + selos dos 3 mais assíduos
const attStore = { v: 0, stats: {}, subs: new Set() };
const attSubscribe = (fn) => { attStore.subs.add(fn); return () => attStore.subs.delete(fn); };
const setAttendanceRows = (rows) => {
  const m = {};
  (rows || []).forEach((r) => { m[r.player_id] = { attended: r.attended, total: r.total, rank: r.rank }; });
  attStore.stats = m;
  attStore.v++;
  attStore.subs.forEach((f) => f());
};
function useAttendance(playerId) {
  useSyncExternalStore(attSubscribe, () => attStore.v);
  const st = attStore.stats[playerId];
  const medal = st && st.attended > 0 && st.rank >= 1 && st.rank <= 3 ? st.rank : 0;
  return { stat: st || null, medal };
}
const SEAL_PATH = "M20.00 0.80 L23.69 3.82 L28.33 2.70 L30.35 7.02 L35.01 8.03 L34.96 12.80 L38.72 15.73 L36.60 20.00 L38.72 24.27 L34.96 27.20 L35.01 31.97 L30.35 32.98 L28.33 37.30 L23.69 36.18 L20.00 39.20 L16.31 36.18 L11.67 37.30 L9.65 32.98 L4.99 31.97 L5.04 27.20 L1.28 24.27 L3.40 20.00 L1.28 15.73 L5.04 12.80 L4.99 8.03 L9.65 7.02 L11.67 2.70 L16.31 3.82Z";
const MEDAL_TONES = { 1: ["#fff3b0", "#f0cc3c", "#8a6410"], 2: ["#ffffff", "#c4cad4", "#6d7380"], 3: ["#ffd2a1", "#cd7f32", "#6b3a10"] };
function AssiduoSeal({ rank, size = 34, label = "Participações em peladas concluídas" }) {
  const [open, setOpen] = useState(false);
  if (!rank) return null;
  const [c1, c2, c3] = MEDAL_TONES[rank];
  const id = `sealg${rank}`;
  const root = typeof document !== "undefined" ? document.querySelector(".pelada-root") || document.body : null;
  return (
    <>
      <button type="button" className="assiduo-seal" style={{ width: size, height: size }} aria-label={`${rank}º em ${label}`}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={c1} /><stop offset=".55" stopColor={c2} /><stop offset="1" stopColor={c3} /></linearGradient></defs>
          <path d={SEAL_PATH} fill={`url(#${id})`} stroke={c3} strokeWidth="1" />
          <circle cx="20" cy="20" r="11.5" fill="none" stroke={c3} strokeOpacity=".55" strokeWidth="1.2" />
          <text x="20" y="25.6" textAnchor="middle" fontFamily="Anton, sans-serif" fontSize="16" fill={c3}>{rank}º</text>
        </svg>
      </button>
      {open && root && createPortal(
        <div className="modal-backdrop modal-center" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>
          <div className="modal assiduo-modal" onClick={(e) => e.stopPropagation()}>
            <div className="assiduo-big"><AssiduoSealFace rank={rank} /></div>
            <h2 className="modal-title">{rank}º em {label}</h2>
            <p className="payment-alert-body">Selo de assiduidade: {rank === 1 ? "o jogador mais presente" : rank === 2 ? "o 2º jogador mais presente" : "o 3º jogador mais presente"} nas listas das peladas já concluídas.</p>
            <button className="btn btn-primary btn-block" onClick={() => setOpen(false)}>OK</button>
          </div>
        </div>, root)}
    </>
  );
}
function AssiduoSealFace({ rank }) {
  const [c1, c2, c3] = MEDAL_TONES[rank];
  const id = `sealf${rank}`;
  return (
    <svg viewBox="0 0 40 40" width="72" height="72" aria-hidden="true">
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={c1} /><stop offset=".55" stopColor={c2} /><stop offset="1" stopColor={c3} /></linearGradient></defs>
      <path d={SEAL_PATH} fill={`url(#${id})`} stroke={c3} strokeWidth="1" />
      <circle cx="20" cy="20" r="11.5" fill="none" stroke={c3} strokeOpacity=".55" strokeWidth="1.2" />
      <text x="20" y="25.6" textAnchor="middle" fontFamily="Anton, sans-serif" fontSize="16" fill={c3}>{rank}º</text>
    </svg>
  );
}
function ProfileAttendance({ playerId }) {
  const { stat, medal } = useAttendance(playerId);
  if (!stat) return null;
  return (
    <div className="profile-attendance">
      <span className="profile-attendance-text">Presença em <b>{stat.attended}/{stat.total}</b> Peladas</span>
      {medal > 0 && <AssiduoSeal rank={medal} size={38} />}
    </div>
  );
}

const STOPWATCH_ID = "00000000-0000-0000-0000-000000000003";
const rowToStopwatch = (r) => r && ({
  status: r.status || "idle",
  durationMin: r.duration_min || 7,
  remainingMs: Number(r.remaining_ms ?? 420000),
  startedBy: r.started_by || null,
  hiddenDate: r.hidden_date || null,
  publishedDate: r.published_date || null,
  lastBy: r.last_by || null,
  history: Array.isArray(r.history) ? r.history : [],
  updatedAt: r.updated_at,
});

// Estado do cronômetro compartilhado (tempo real). `authUser` null => nada carrega.
function useSharedStopwatch(authUser, actor) {
  const [row, setRow] = useState(null);
  const [, setTick] = useState(0);
  const offsetRef = useRef(0); // relógio do servidor - relógio local
  const audioRef = useRef(null);
  const lockRef = useRef(null);
  const wasFinishedRef = useRef(null);
  const uid = authUser?.id || null;

  const getAudio = () => {
    if (!audioRef.current) {
      const a = new Audio(`${import.meta.env.BASE_URL || "/"}alarm.mp3`);
      a.preload = "auto";
      audioRef.current = a;
    }
    return audioRef.current;
  };
  // precisa nascer de um toque do usuário (iPhone)
  const unlockAudio = () => {
    try {
      const a = getAudio();
      if (!a.paused) return;
      a.muted = true;
      a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
    } catch {}
  };
  const stopAlarm = () => {
    const a = audioRef.current;
    if (a) { a.pause(); a.currentTime = 0; }
  };

  useEffect(() => {
    if (!uid) { setRow(null); return undefined; }
    let alive = true;
    (async () => {
      try {
        const t0 = Date.now();
        const { data: sn } = await supabase.rpc("server_now");
        if (sn) offsetRef.current = Date.parse(sn) - (t0 + Date.now()) / 2;
      } catch {}
      const { data } = await supabase.from("stopwatch_state").select("*").eq("id", STOPWATCH_ID).maybeSingle();
      if (alive && data) setRow(rowToStopwatch(data));
    })();
    const channel = supabase
      .channel("stopwatch-shared")
      .on("postgres_changes", { event: "*", schema: "public", table: "stopwatch_state", filter: `id=eq.${STOPWATCH_ID}` },
        (payload) => { if (payload.new) setRow(rowToStopwatch(payload.new)); })
      .subscribe();
    return () => { alive = false; supabase.removeChannel(channel); };
  }, [uid]);

  const serverNow = () => Date.now() + offsetRef.current;
  const st = row?.status || "idle";
  const endAt = st === "running" && row ? Date.parse(row.updatedAt) + row.remainingMs : 0;
  const remaining = !row ? 420000 : st === "running" ? Math.max(0, endAt - serverNow()) : st === "idle" ? row.durationMin * 60000 : row.remainingMs;
  const running = st === "running" && remaining > 0;
  const finished = st === "running" && remaining <= 0;

  // relógio (100ms) só enquanto corre
  useEffect(() => {
    if (st !== "running") return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [st, row?.updatedAt]);

  // tela acesa durante o jogo
  useEffect(() => {
    if (!running) { try { lockRef.current?.release(); } catch {} lockRef.current = null; return undefined; }
    (async () => { try { if (navigator.wakeLock && !lockRef.current) lockRef.current = await navigator.wakeLock.request("screen"); } catch {} })();
    return undefined;
  }, [running]);

  // alarme em todos os aparelhos quando acaba (só se acabou agora, não ao abrir o app depois)
  useEffect(() => {
    if (wasFinishedRef.current === null) { wasFinishedRef.current = finished; return; }
    if (finished && !wasFinishedRef.current && serverNow() - endAt < 20000) {
      try {
        const a = getAudio();
        a.muted = false; a.currentTime = 0; a.play().catch(() => {});
        navigator.vibrate?.([300, 150, 300, 150, 600]);
      } catch {}
    }
    if (!finished) stopAlarm();
    wasFinishedRef.current = finished;
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  async function write(patch, entry) {
    const cur = row || { status: "idle", durationMin: 7, remainingMs: 420000, startedBy: null, history: [] };
    let history = cur.history;
    if (entry) {
      const base = history.length >= 3 ? [] : history; // zera a cada 3 modificações
      history = [...base, { a: entry, by: actor, at: new Date().toISOString() }];
    }
    const next = {
      id: STOPWATCH_ID,
      status: cur.status,
      duration_min: cur.durationMin,
      remaining_ms: cur.remainingMs,
      started_by: cur.startedBy,
      last_by: actor,
      history,
      ...patch,
    };
    const { data, error } = await supabase.from("stopwatch_state").upsert(next).select().single();
    if (!error && data) {
      setRow(rowToStopwatch(data));
      offsetRef.current = Date.parse(data.updated_at) - Date.now();
    }
    return !error;
  }
  const dur = row?.durationMin || 7;
  const actions = {
    start: () => {
      unlockAudio();
      const fromIdle = st === "idle" || finished;
      return write(
        { status: "running", remaining_ms: fromIdle ? dur * 60000 : remaining, started_by: fromIdle ? actor : row?.startedBy },
        fromIdle ? "Iniciado" : "Retomado"
      );
    },
    pause: () => write({ status: "paused", remaining_ms: Math.round(remaining) }, "Pausado"),
    reset: () => { stopAlarm(); return write({ status: "idle", remaining_ms: dur * 60000, started_by: null }, "Resetado"); },
    hideToday: () => write({ hidden_date: todayBRT(), published_date: null }, null),
    publish: () => write({ published_date: todayBRT(), hidden_date: null }, null),
    setMinutes: (m) => write({ status: "idle", duration_min: m, remaining_ms: m * 60000, started_by: null }, null),
  };
  return { loaded: !!row, st, remaining, running, finished, idle: st === "idle", durationMin: dur,
    startedBy: row?.startedBy, hiddenDate: row?.hiddenDate || null, publishedDate: row?.publishedDate || null, history: row?.history || [], unlockAudio, stopAlarm, actions };
}

function StopwatchModal({ sw, push, isAdmin, onHide, onClose: onCloseProp }) {
  const [busy, setBusy] = useState(false);
  const onClose = () => { fxClose(onCloseProp); };
  const act = async (fn) => { if (busy) return; setBusy(true); try { await fn(); } finally { setBusy(false); } };
  const { remaining, running, finished, idle, durationMin } = sw;
  const secs = Math.ceil(remaining / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  const warning = running && secs <= 10 && secs > 0;
  const fmtAt = (iso) => { try { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }); } catch { return ""; } };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sb-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Emo e="⏱" /> Cronômetro</h2>
        <div className={`sb-board ${warning ? "sb-warn" : ""} ${finished ? "sb-done" : ""}`}>
          {warning && <div key={secs} className="sb-flash" />}
          <div className="sb-lamps"><i /><i /><i /><i /></div>
          <div className={`sb-digits ${finished ? "sb-blink" : ""}`} role="timer" aria-label={`${mm} minutos e ${ss} segundos`}>
            <SevenSeg n={Number(mm[0])} />
            <SevenSeg n={Number(mm[1])} />
            <div className={`sb-colon ${running ? "sb-colon-run" : ""}`}><i /><i /></div>
            <SevenSeg n={Number(ss[0])} />
            <SevenSeg n={Number(ss[1])} />
          </div>
          <div className="sb-caption">{finished ? "TEMPO ESGOTADO" : running ? "EM JOGO" : idle ? `${durationMin} MIN` : "PAUSADO"}</div>
        </div>
        <div className="sb-by">{sw.startedBy && !idle ? `iniciado por ${sw.startedBy}` : " "}</div>
        {idle && (
          <div className="sb-adjust">
            <button className="btn btn-ghost" disabled={busy} onClick={() => act(() => sw.actions.setMinutes(Math.max(1, durationMin - 1)))} aria-label="Menos um minuto">− 1 MIN</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => act(() => sw.actions.setMinutes(Math.min(60, durationMin + 1)))} aria-label="Mais um minuto">+ 1 MIN</button>
          </div>
        )}
        <div className="sb-actions">
          {finished ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(sw.actions.reset)}>REINICIAR</button>
          ) : running ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(sw.actions.pause)}>PAUSAR</button>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={() => { push.enable(); act(sw.actions.start); }}>{sw.st === "paused" ? "RETOMAR" : "INICIAR"}</button>
          )}
          <button className="btn btn-ghost" disabled={busy} onClick={() => act(sw.actions.reset)}>RESET</button>
        </div>
        {sw.history.length > 0 && (
          <ul className="sb-history" aria-label="Histórico">
            {[...sw.history].reverse().map((h, i) => (
              <li key={`${h.at}-${i}`}>{h.a} por <b>{h.by}</b> · {fmtAt(h.at)}</li>
            ))}
          </ul>
        )}
        {isAdmin && (
          <button className="btn btn-ghost btn-block sb-hide" disabled={busy} onClick={() => act(async () => { await sw.actions.hideToday(); onHide?.(); })}>
            REMOVER DA HOME (HOJE)
          </button>
        )}
        <div className="sb-push">
          {push.status === "on" || push.status === "off" ? null : (
            <p className="sb-push-note">
              {push.status === "needs-install" ? "No iPhone: toque em Compartilhar › \"Adicionar à Tela de Início\" e abra o app por lá pra ativar o aviso com o app fechado."
                : push.status === "denied" ? "Notificações bloqueadas neste aparelho. Libere nas configurações do navegador/app pra ativar o aviso."
                : "Este aparelho não suporta aviso com o app fechado."}
            </p>
          )}
        </div>
        <button className="link profile-close-link" onClick={onClose}>Fechar</button>
      </div>
    </div>
  );
}

function StopwatchBanner({ sw, push, onOpen }) {
  const secs = Math.ceil(sw.remaining / 1000);
  const t = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  const live = sw.running || sw.finished;
  return (
    <button className={`presence-open-banner stopwatch-banner ${live ? "" : "sw-idle"}`} onClick={() => { sw.unlockAudio(); push.enable(); onOpen(); }}>
      <span className="pob-in">
        <span className="pob-left">
          {live ? <span className="pob-live"><i className="pob-dot" />AO VIVO</span> : <span className="pob-live">PLACAR ELETRÔNICO</span>}
          <span className="presence-open-banner-title">CRONÔMETRO</span>
          {live && sw.startedBy && <span className="sw-by">iniciado por {sw.startedBy}</span>}
        </span>
        <span className="presence-open-banner-cta">{sw.finished ? "00:00" : sw.st !== "idle" ? t : "ABRIR"}<i className="pob-arrow" /></span>
      </span>
    </button>
  );
}

function Styles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@500;600&family=Barlow+Condensed:ital,wght@0,500;0,600;0,700;0,800;1,600;1,700;1,800&family=Inter:wght@400;500;600;700&display=swap');

      .pelada-root {
        --bg: #0a0908;
        --surface: #15120f;
        --surface-2: #1d1815;
        --border: #322a20;
        --text: #f4f1ea;
        --text-dim: #948c7e;
        --gold: #f0cc3c;
        --gold-dark: #b8923a;
        --gold-soft: rgba(240,204,60,0.12);
        --maroon: #7a1f1f;
        --maroon-light: #a52e2e;
        --maroon-soft: rgba(165,46,46,0.16);
        --silver: #b7bfcb;
        --danger: #e8656d;

        font-family: 'Inter', system-ui, sans-serif;
        background: var(--bg);
        color: var(--text);
        min-height: 100vh;
        min-height: 100dvh;
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-bottom: max(24px, env(safe-area-inset-bottom));
        overflow-x: hidden;
        -webkit-tap-highlight-color: transparent;
      }

      .stadium-bg {
        position: fixed; inset: 0; z-index: 0; overflow: hidden;
        pointer-events: none; background: var(--bg);
      }
      .stadium-photo {
        position: absolute; inset: -8%;
        background-image: url('${STADIUM_DATA_URL}');
        background-size: cover; background-position: center 20%;
        filter: saturate(1.08) brightness(0.82);
        will-change: transform;
      }
      .stadium-glow {
        position: absolute; inset: -10%;
        background:
          radial-gradient(160px 70px at 20% 33%, rgba(255,255,255,0.32), transparent 70%),
          radial-gradient(180px 80px at 80% 31%, rgba(255,255,255,0.28), transparent 70%),
          radial-gradient(220px 100px at 50% 28%, rgba(255,255,255,0.2), transparent 75%);
        mix-blend-mode: screen;
        animation: floodPulse 4.5s ease-in-out infinite alternate;
        will-change: transform, opacity;
      }
      @keyframes floodPulse { from { opacity: .6; } to { opacity: 1; } }
      .floating-logo {
        position: absolute; width: 230px; height: auto; left: 50%; top: 20%;
        opacity: 0.14; filter: drop-shadow(0 14px 28px rgba(0,0,0,0.6));
        will-change: transform;
      }
      .stadium-vignette {
        position: absolute; inset: 0;
        background:
          linear-gradient(180deg, rgba(6,7,8,0.55) 0%, rgba(8,8,7,0.22) 26%, rgba(9,8,7,0.72) 78%, rgba(9,8,7,0.96) 100%),
          radial-gradient(ellipse at 50% 12%, rgba(0,0,0,0) 0%, rgba(5,5,5,0.5) 78%);
      }

      .pelada-content {
        position: relative; z-index: 1; width: 100%;
        display: flex; flex-direction: column; align-items: center;
      }
      .pelada-root * { box-sizing: border-box; }
      .pelada-root h1, .pelada-root h2 { font-family: 'Anton', 'Barlow Condensed', sans-serif; font-weight: 400; letter-spacing: 0.3px; }

      .center-msg { padding: 48px; color: var(--text-dim); }

      .topbar {
        width: 100%; max-width: 480px; padding: max(20px, env(safe-area-inset-top)) 20px 14px;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        position: relative;
      }
      .admin-gear-btn {
        position: absolute; top: max(14px, env(safe-area-inset-top)); right: 16px; width: 40px; height: 40px;
        border-radius: 50%; background: var(--surface); border: 1px solid var(--border);
        color: var(--text-dim); font-size: 16px; cursor: pointer; touch-action: manipulation;
        display: flex; align-items: center; justify-content: center;
      }
      .admin-gear-btn:hover { border-color: var(--gold-dark); color: var(--gold); }
      .logo-crest { width: 100px; height: 100px; object-fit: contain; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.55)); display: block; }
      .logo-crest-btn {
        background: none; border: none; padding: 0; margin: 0; cursor: pointer;
        border-radius: 50%; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
        transition: transform 0.15s ease;
      }
      .logo-crest-btn:hover { transform: scale(1.04); }
      .logo-crest-btn:active { transform: scale(0.96); }
      .logo-crest-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(228,181,89,0.35); }
      .topbar-divider { width: 64px; height: 2px; background: linear-gradient(90deg, transparent, var(--gold-dark), transparent); margin: 2px 0 4px; }
      .topbar-caption {
        font-family: 'Barlow Condensed', sans-serif; font-weight: 600; font-size: 12px;
        letter-spacing: 2px; text-transform: uppercase; color: var(--text-dim); text-align: center;
      }

      .screen { width: 100%; max-width: 480px; padding: 8px 20px 100px; }

      .screen-head { display: flex; align-items: center; gap: 10px; margin: 6px 0 16px; }
      .screen-head h1 {
        font-size: 32px; margin: 0;
      }
      /* ---- stories (fotos/vídeos temporários, estilo Instagram) ---- */
      .stories-row {
        display: flex; gap: 14px; overflow-x: auto; padding: 4px 2px 12px;
        margin-bottom: 4px; -webkit-overflow-scrolling: touch;
      }
      .stories-row::-webkit-scrollbar { display: none; }
      .story-circle-wrap { position: relative; flex-shrink: 0; }
      .story-circle-btn {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        background: none; border: none; cursor: pointer; flex-shrink: 0; width: 64px;
      }
      .story-ring {
        width: 64px; height: 64px; border-radius: 50%; display: flex; align-items: center;
        justify-content: center; flex-shrink: 0; padding: 3px;
        background: var(--surface-2);
      }
      .story-ring-unseen {
        background: linear-gradient(135deg, var(--gold), #c98f2a, #8f5f13);
      }
      .story-ring-seen { background: var(--border); }
      .story-ring-empty { background: var(--border); border: 1.5px dashed var(--text-dim); }
      .story-ring .avatar { border: 2px solid var(--surface); }
      .story-circle-label {
        font-size: 10.5px; color: var(--text-dim); max-width: 64px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .story-add-badge {
        position: absolute; bottom: 20px; right: 0; width: 22px; height: 22px; border-radius: 50%;
        background: var(--gold); color: #221a0d; border: 2px solid var(--surface);
        font-size: 15px; line-height: 1; font-weight: 800; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }

      .story-source-sheet { display: flex; flex-direction: column; gap: 8px; }
      .story-source-option {
        display: flex; align-items: center; width: 100%; text-align: left;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px;
        padding: 14px 16px; font-size: 14.5px; font-weight: 600; color: var(--text); cursor: pointer;
      }
      .story-source-option:hover { border-color: var(--gold); }

      .story-camera-backdrop {
        background: #000; display: flex; align-items: center; justify-content: center;
        z-index: 2000;
      }
      .story-camera-modal {
        position: relative; width: 100%; height: 100%; max-width: 520px;
        display: flex; align-items: center; justify-content: center; background: #000;
      }
      .story-camera-preview {
        width: 100%; height: 100%; object-fit: cover; background: #000;
      }
      .story-camera-close {
        position: absolute; top: max(14px, env(safe-area-inset-top)); left: 14px; width: 38px; height: 38px;
        border-radius: 50%; background: rgba(0,0,0,0.45); color: #fff; border: none;
        font-size: 18px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
      }
      .story-camera-timer {
        position: absolute; top: max(14px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.45); color: #fff; font-size: 13px; font-weight: 700;
        padding: 6px 12px; border-radius: 999px; letter-spacing: 0.02em;
      }
      .story-camera-timer.is-recording { background: rgba(214, 60, 60, 0.85); }
      .story-camera-controls {
        position: absolute; bottom: max(28px, env(safe-area-inset-bottom)); left: 0; right: 0;
        display: flex; align-items: center; justify-content: center; gap: 18px; padding: 0 20px;
      }
      .story-camera-record-btn {
        width: 74px; height: 74px; border-radius: 50%; background: #fff;
        border: 5px solid rgba(255,255,255,0.5); cursor: pointer; padding: 0;
      }
      .story-camera-record-btn.is-recording {
        background: #d63c3c; border-radius: 14px; width: 34px; height: 34px;
        border: none; margin: 20px;
      }
      .story-camera-error {
        color: #fff; text-align: center; padding: 24px; display: flex; flex-direction: column; gap: 14px;
      }

      .story-viewer-backdrop {
        position: fixed; inset: 0; background: #000; z-index: 60;
        display: flex; align-items: center; justify-content: center;
      }
      .story-viewer {
        position: relative; width: 100%; height: 100%; max-width: 480px;
        background: #000; overflow: hidden;
      }
      .story-progress-row {
        position: absolute; top: max(10px, env(safe-area-inset-top)); left: 8px; right: 8px;
        z-index: 3; display: flex; gap: 4px;
      }
      .story-progress-track {
        flex: 1; height: 3px; border-radius: 3px; background: rgba(255,255,255,0.3); overflow: hidden;
      }
      .story-progress-fill { display: block; height: 100%; width: 0%; background: #fff; }
      @keyframes storyProgressFill { from { width: 0%; } to { width: 100%; } }
      .story-viewer-head {
        position: absolute; top: max(24px, calc(env(safe-area-inset-top) + 14px)); left: 12px; right: 12px;
        z-index: 3; display: flex; align-items: center; gap: 8px;
      }
      .story-viewer-head .avatar { border: 1.5px solid rgba(255,255,255,0.5); }
      .story-viewer-name { font-size: 13.5px; font-weight: 700; color: #fff; }
      .story-viewer-time { font-size: 12px; color: rgba(255,255,255,0.7); }
      .story-viewer-icon-btn {
        background: rgba(0,0,0,0.4); border: none; color: #fff; font-size: 16px;
        width: 34px; height: 34px; border-radius: 50%; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }
      .story-viewer-media {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      }
      .story-media-el { width: 100%; height: 100%; object-fit: contain; background: #000; }
      .story-nav-zone {
        position: absolute; top: 0; bottom: 92px; width: 33%; background: none; border: none;
        z-index: 2; padding: 0; cursor: pointer;
      }
      .story-nav-prev { left: 0; }
      .story-nav-next { right: 0; }

      .story-reaction-flash {
        position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
        z-index: 5; background: rgba(0,0,0,0.55); color: #fff; font-size: 15px; font-weight: 700;
        padding: 10px 18px; border-radius: 999px; pointer-events: none;
        animation: storyFlashPop 0.9s ease forwards;
      }
      @keyframes storyFlashPop {
        0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
        20% { opacity: 1; transform: translate(-50%, -50%) scale(1.05); }
        80% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(1); }
      }

      .story-bottom-bar {
        position: absolute; left: 0; right: 0; bottom: 0; z-index: 4;
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 10px 12px max(12px, env(safe-area-inset-bottom));
        background: linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.75) 55%, rgba(0,0,0,0.85) 100%);
      }
      .story-viewers-pill {
        background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.25); color: #fff;
        font-size: 12px; font-weight: 600; border-radius: 999px; padding: 8px 12px; cursor: pointer;
        white-space: nowrap; flex-shrink: 0;
      }
      .story-reactions-bar {
        display: flex; align-items: center; gap: 6px; margin-left: auto;
      }
      .story-reaction-btn {
        background: rgba(255,255,255,0.1); border: 1px solid transparent; border-radius: 50%;
        width: 34px; height: 34px; font-size: 17px; cursor: pointer;
        display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      }
      .story-reaction-btn-active { background: rgba(228,181,89,0.3); border-color: var(--gold); }
      .story-like-btn {
        background: rgba(255,255,255,0.1); border: none; border-radius: 50%;
        width: 38px; height: 38px; font-size: 19px; cursor: pointer;
        display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      }
      .story-like-btn-active { background: rgba(200,60,80,0.25); }

      .story-viewers-panel {
        position: absolute; left: 0; right: 0; bottom: 0; z-index: 5; max-height: 60%;
        background: #100e0b; border-radius: 18px 18px 0 0; padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
        display: flex; flex-direction: column; box-shadow: 0 -8px 30px rgba(0,0,0,0.5);
      }
      .story-viewers-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
      .story-viewers-panel-title { font-size: 14px; font-weight: 700; color: #fff; }
      .story-viewers-panel-list { overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .story-viewer-row { display: flex; align-items: center; gap: 10px; padding: 7px 2px; }
      .story-viewer-row-name { flex: 1; font-size: 13.5px; color: #fff; font-weight: 600; }
      .story-viewer-row-icons { display: flex; gap: 4px; font-size: 15px; }

      .member-search { position: relative; margin-bottom: 16px; }
      .member-search-box {
        display: flex; align-items: center; gap: 8px;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 14px;
        padding: 12px 14px;
      }
      .member-search-icon { font-size: 14px; opacity: 0.75; }
      .member-search-input {
        flex: 1; background: none; border: none; outline: none; color: var(--text);
        font-size: 16px; min-width: 0;
      }
      .member-search-input::placeholder { color: var(--text-dim); }
      .member-search-clear {
        background: none; border: none; color: var(--text-dim); font-size: 18px;
        cursor: pointer; line-height: 1; padding: 0 2px;
      }
      .member-search-suggestions {
        position: absolute; z-index: 30; top: calc(100% + 6px); left: 0; right: 0;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 14px;
        padding: 6px; box-shadow: 0 12px 32px rgba(0,0,0,0.45);
        max-height: 320px; overflow-y: auto;
      }
      .member-search-item {
        display: flex; align-items: center; gap: 10px; width: 100%;
        background: transparent; border: none; border-radius: 10px; padding: 8px;
        cursor: pointer; text-align: left;
      }
      .member-search-item:hover { background: rgba(228,181,89,0.12); }
      .member-search-item-text { display: flex; flex-direction: column; min-width: 0; }
      .member-search-item-name { font-size: 13.5px; font-weight: 700; color: var(--text); }
      .member-search-item-fullname { font-size: 11.5px; color: var(--text-dim); }
      .member-search-empty { padding: 14px; text-align: center; color: var(--text-dim); font-size: 13px; }

      .count-pill {
        background: var(--surface-2); border: 1px solid var(--border);
        border-radius: 999px; padding: 3px 12px; font-size: 13px; color: var(--text-dim);
      }
      .count-pill-lg { font-size: 14px; padding: 5px 14px; color: var(--text); }
      .count-pill-sm { font-size: 11px; padding: 1px 8px; margin-left: 5px; }

      .membership-badge {
        display: inline-flex; align-items: center; gap: 4px; font-size: 11px;
        font-weight: 700; letter-spacing: 0.2px; padding: 2px 9px 2px 7px;
        border-radius: 999px; margin-top: 4px; width: fit-content;
      }
      .membership-badge-mensalista {
        background: linear-gradient(135deg, rgba(228,181,89,0.22), rgba(228,181,89,0.1));
        color: var(--gold); border: 1px solid rgba(228,181,89,0.4);
      }
      .membership-badge-avulso {
        background: var(--surface-2); color: var(--text-dim); border: 1px solid var(--border);
      }
      .membership-badge-icon { font-size: 12px; }
      .membership-badge-roster { margin-top: 3px; }
      .membership-badge-profile { margin: -4px 0 14px; }
      .membership-badge-inline { margin-top: 3px; }

      .membership-interest-box { margin-top: 10px; }

      .interest-row-info { display: flex; flex-direction: column; flex: 1; min-width: 0; }
      .interest-row-date { font-size: 11px; color: var(--text-dim); }
      .interest-added-by { color: var(--gold); font-weight: 600; }
      .interest-temp-paren { font-weight: 500; color: var(--text-dim); }
      .interest-row-temp { opacity: 0.92; }
      .interest-row-temp .presence-num { color: var(--gold); }

      /* Admin: caixa de seleção pra incluir na lista de interessados */
      .interest-add-trigger { margin: 4px 0 14px; border-style: dashed; }
      .interest-add-box {
        background: var(--surface-2); border: 1px solid var(--gold);
        border-radius: 14px; padding: 12px; margin: 4px 0 16px;
        display: flex; flex-direction: column; gap: 10px;
      }
      .interest-add-head { display: flex; align-items: center; justify-content: space-between; }
      .interest-add-title {
        font-size: 12px; font-weight: 700; letter-spacing: 1px;
        text-transform: uppercase; color: var(--gold);
      }
      .interest-add-list {
        list-style: none; margin: 0; padding: 0; max-height: 40vh; overflow-y: auto;
        display: flex; flex-direction: column; gap: 6px;
      }
      .interest-add-option {
        display: flex; align-items: center; gap: 10px; width: 100%;
        background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
        padding: 7px 10px; color: var(--text); cursor: pointer; text-align: left;
      }
      .interest-add-option.is-checked { border-color: var(--gold); background: var(--gold-soft); }
      .interest-add-check {
        width: 22px; height: 22px; flex-shrink: 0; border-radius: 6px;
        border: 2px solid var(--border); display: inline-flex; align-items: center;
        justify-content: center; font-size: 11px; font-weight: 800; color: #1a1406;
      }
      .interest-add-option.is-checked .interest-add-check { background: var(--gold); border-color: var(--gold); }

      /* Mensalista temporário */
      .temp-make-link {
        align-self: flex-start; margin-top: 3px; padding: 0;
        font-size: 11.5px; font-weight: 600; color: var(--gold);
      }
      .temp-pick-list { margin-top: 12px; max-height: 50vh; overflow-y: auto; }
      .temp-pick-option {
        display: flex; align-items: center; gap: 10px; width: 100%;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px;
        padding: 8px 12px; color: var(--text); cursor: pointer; text-align: left;
      }
      .temp-pick-option:active { transform: scale(0.99); }
      @media (hover: hover) and (pointer: fine) {
        .temp-pick-option:hover { border-color: var(--gold); }
      }
      .temp-pick-gk {
        margin-left: auto; font-size: 11px; color: var(--text-dim);
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .temp-mensalista-tag { font-size: 11.5px; font-weight: 600; color: var(--gold); }
      .temp-mensalista-actions {
        display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; font-size: 12px;
      }
      .temp-mensalista-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      .mens-btn {
        font-family: inherit; font-size: 12px; font-weight: 700; letter-spacing: 0.02em;
        padding: 8px 14px; border-radius: 10px; cursor: pointer; line-height: 1.1;
        color: var(--btn-c); border: 1px solid var(--btn-c);
        background: linear-gradient(180deg, color-mix(in srgb, var(--btn-c) 26%, #1a1613) 0%, color-mix(in srgb, var(--btn-c) 10%, #120f0c) 100%);
        box-shadow: 0 2px 0 color-mix(in srgb, var(--btn-c) 45%, #000), 0 4px 10px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.14);
        transition: transform 0.08s ease, box-shadow 0.08s ease, filter 0.15s ease;
        -webkit-tap-highlight-color: transparent;
      }
      .mens-btn:hover { filter: brightness(1.15); }
      .mens-btn:active {
        transform: translateY(2px);
        box-shadow: 0 0 0 color-mix(in srgb, var(--btn-c) 45%, #000), 0 1px 3px rgba(0,0,0,0.5), inset 0 1px 3px rgba(0,0,0,0.4);
      }
      .temp-mensalista-row .temp-mensalista-actions { flex-wrap: nowrap; gap: 6px; align-items: stretch; }
      .temp-mensalista-row .mens-btn {
        flex: 1 1 auto; min-width: 0; padding: 8px 6px; font-size: 11px; line-height: 1.15;
        text-align: center; white-space: normal;
      }
      .send-alert-btn { padding: 5px 10px; font-size: 11px; }
      .mens-btn-gold { --btn-c: var(--gold, #e8b93c); }
      .mens-btn-danger { --btn-c: var(--danger, #e5534b); }
      .mens-btn-green { --btn-c: #5fbf6a; }

      /* PIX do mês */
      .pix-active-card {
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        background: var(--gold-soft); border: 1px solid var(--gold);
        border-radius: 14px; padding: 14px; margin: 4px 0 14px; text-align: center;
      }
      .pix-active-label { font-size: 10.5px; font-weight: 700; letter-spacing: 1.5px; color: var(--gold); }
      .pix-active-name { font-size: 16px; font-weight: 700; color: var(--text); }
      .pix-active-key { font-size: 13px; color: var(--text-dim); word-break: break-all; }
      .pix-key-input { margin: 8px 0 10px; }
      .reorder-btns { display: flex; flex-direction: column; gap: 2px; flex-shrink: 0; }
      .reorder-btn {
        width: 22px; height: 18px; padding: 0; display: flex; align-items: center; justify-content: center;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px;
        color: var(--text-dim); font-size: 10px; line-height: 1; cursor: pointer;
      }
      .reorder-btn:hover:not(:disabled) { border-color: var(--gold); color: var(--gold); }
      .reorder-btn:disabled { opacity: 0.3; cursor: default; }

      .payment-alert-modal { text-align: center; }
      .payment-alert-icon { font-size: 40px; margin-bottom: 4px; }
      .payment-alert-title { margin-bottom: 6px; }
      .payment-alert-body { color: var(--text-dim); font-size: 14px; line-height: 1.5; margin: 0 0 16px; }
      .payment-alert-card {
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 16px;
        padding: 16px; text-align: left; display: flex; flex-direction: column; gap: 8px;
        margin-bottom: 16px;
      }
      .payment-alert-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
      .payment-alert-label { font-size: 11px; letter-spacing: 0.4px; color: var(--text-dim); text-transform: uppercase; }
      .payment-alert-value { font-size: 14px; font-weight: 600; word-break: break-all; text-align: right; }
      .payment-alert-amount-row { padding-top: 8px; border-top: 1px dashed var(--border); margin-top: 4px; }
      .payment-alert-amount { font-size: 22px; font-weight: 800; color: var(--gold); }
      .payment-alert-copy { margin-top: 4px; align-self: center; }
      .payment-alert-footer { color: var(--text-dim); font-size: 13px; line-height: 1.5; margin-bottom: 18px; }

      .announcement-modal { text-align: center; }
      .announcement-icon { font-size: 36px; margin-bottom: 4px; }
      .announcement-title { margin-bottom: 8px; }
      .announcement-message { font-size: 14.5px; line-height: 1.6; color: var(--text); white-space: pre-wrap; margin: 0 0 14px; }
      .announcement-expiry { font-size: 12px; color: var(--text-dim); margin-bottom: 18px; }

      .announcement-current {
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 14px;
        padding: 12px 14px; margin-bottom: 16px;
      }
      .announcement-current-title { font-weight: 700; margin: 4px 0 2px; }
      .announcement-current-message { font-size: 13.5px; color: var(--text-dim); white-space: pre-wrap; margin: 0 0 6px; }

      .announcement-mode-row { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
      .switch-row.announcement-mode-option { justify-content: flex-start; gap: 10px; }
      .announcement-mode-option input[type="radio"] { width: 16px; height: 16px; flex-shrink: 0; }
      .announcement-mode-option span { font-size: 13.5px; text-align: left; }

      .access-blocked-box {
        margin-top: 10px; padding: 14px; border-radius: 14px;
        background: rgba(229, 72, 77, 0.1); border: 1px solid rgba(229, 72, 77, 0.35);
      }
      .access-blocked-text { font-size: 13px; line-height: 1.5; margin: 0 0 10px; color: var(--text); }

      .payment-tabs { display: flex; gap: 6px; margin-bottom: 14px; background: var(--surface-2); padding: 4px; border-radius: 12px; }
      .payment-tab {
        flex: 1; border: none; background: none; padding: 8px 10px; border-radius: 9px;
        font-size: 13px; font-weight: 600; color: var(--text-dim); cursor: pointer;
      }
      .payment-tab-active { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.15); }

      .block-unpaid-row { margin-top: 4px; }

      .paid-pill {
        border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px;
        font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap;
      }
      .paid-pill-pending { background: rgba(229, 72, 77, 0.1); color: #E5484D; border-color: rgba(229, 72, 77, 0.35); }
      .paid-pill-paid { background: rgba(52, 199, 123, 0.12); color: #34C77B; border-color: rgba(52, 199, 123, 0.35); }

      .back-link {
        background: none; border: none; color: var(--text-dim); font-size: 14px;
        padding: 6px 0; cursor: pointer; margin-bottom: 6px;
      }
      .back-link:hover { color: var(--text); }
      .back-link-secondary { display: block; margin-left: 12px; color: var(--gold); }

      .step-dots { display: flex; gap: 18px; margin-bottom: 18px; }
      .step-dot { display: flex; align-items: center; gap: 6px; opacity: 0.4; }
      .step-dot-active, .step-dot-done { opacity: 1; }
      .step-dot-num {
        width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--border);
        display: flex; align-items: center; justify-content: center; font-size: 11px;
      }
      .step-dot-active .step-dot-num { background: var(--gold); color: #1a1206; border-color: var(--gold); }
      .step-dot-done .step-dot-num { background: var(--surface-2); border-color: var(--text-dim); }
      .step-dot-label { font-size: 12px; color: var(--text-dim); }
      .step-dot-active .step-dot-label { color: var(--text); }

      .btn {
        font-family: 'Inter', sans-serif; font-weight: 700; font-size: 15px;
        border-radius: 13px; padding: 14px 22px; border: 1px solid transparent;
        cursor: pointer; transition: transform .12s ease, filter .12s ease, opacity .12s ease;
        letter-spacing: 0.2px; touch-action: manipulation;
      }
      .btn:active { transform: scale(0.98); }
      .btn:disabled { opacity: 0.32; cursor: not-allowed; filter: none; }
      .btn-block { width: 100%; }
      .interest-cta-btn {
        display: flex; align-items: center; justify-content: center; gap: 8px;
      }
      .mensalidade-cta-btn {
        display: flex; flex-direction: column; align-items: center; gap: 3px;
        width: 100%; margin-bottom: 20px; padding: 14px 16px; cursor: pointer;
        border-radius: 16px; border: 1px solid var(--gold);
        background: var(--gold-soft); color: var(--text);
      }
      .mensalidade-cta-btn:active { transform: scale(0.99); }
      .mensalidade-cta-title { font-size: 16px; font-weight: 900; letter-spacing: 0.6px; color: var(--gold); }
      .mensalidade-cta-sub { font-size: 12px; color: var(--text-dim); text-align: center; }
      .mensalidade-cta-btn.is-reported { border-color: var(--border); background: var(--surface-2); }
      .mensalidade-cta-btn.is-reported .mensalidade-cta-title { color: var(--text); }
      .mensalidade-cta-btn.is-reported .mensalidade-cta-sub { color: #6fcf7a; }
      .payment-alert-actions { display: flex; flex-direction: column; gap: 8px; }
      .payment-alert-note { font-weight: 600; color: var(--gold); }
      .reported-paid-tag { font-size: 11.5px; font-weight: 600; color: #6fcf7a; }
      .btn-sm { padding: 9px 16px; font-size: 13px; border-radius: 10px; }
      .btn-primary {
        background: linear-gradient(180deg, #ffe27a 0%, var(--gold) 42%, var(--gold-dark) 100%);
        color: #241a06; box-shadow: 0 1px 0 rgba(255,255,255,0.4) inset, 0 6px 16px rgba(240,204,60,0.18);
        border: 1px solid #8f6f24;
      }
      .btn-primary:not(:disabled):hover { filter: brightness(1.06); }
      .btn-ghost {
        background: linear-gradient(180deg, var(--surface-2) 0%, var(--surface) 100%);
        color: var(--text); border-color: var(--border);
      }
      .btn-ghost:not(:disabled):hover { border-color: var(--gold-dark); }
      .btn-danger-text { background: none; color: var(--danger); border: 1px solid transparent; }
      .btn-danger {
        background: linear-gradient(180deg, #e8656d 0%, var(--maroon-light) 55%, var(--maroon) 100%);
        color: #fff; border: 1px solid var(--maroon);
        box-shadow: 0 1px 0 rgba(255,255,255,0.15) inset, 0 6px 16px rgba(165,46,46,0.2);
      }
      .btn-danger:not(:disabled):hover { filter: brightness(1.06); }

      .bottom-bar {
        position: sticky; bottom: 0; margin-top: 22px; padding-top: 10px;
        padding-bottom: env(safe-area-inset-bottom);
        background: linear-gradient(to top, var(--bg) 60%, transparent);
      }
      .bottom-hint { text-align: center; font-size: 12px; color: var(--text-dim); margin: 8px 0 0; }
      .admin-only-hint { margin: 20px 0 0; padding-top: 14px; border-top: 1px solid var(--border); }

      .empty-hint { color: var(--text-dim); font-size: 14px; line-height: 1.5; margin-top: 18px; }

      .roster-list { list-style: none; margin: 16px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .roster-row {
        display: flex; flex-direction: column; background: var(--surface);
        border: 1px solid var(--border); border-radius: 16px; padding: 9px 10px; cursor: pointer;
      }
      .roster-row:hover { border-color: var(--gold-dark); }
      .roster-row-main { display: flex; align-items: center; gap: 12px; }
      .roster-info { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
      .roster-name { font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .roster-fullname { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .roster-sub { font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .stars { color: var(--gold); font-size: 13px; letter-spacing: 1px; }
      .badge { font-size: 16px; }
      .badge-sm { font-size: 13px; }
      .roster-row-footer {
        display: flex; justify-content: flex-end; margin-top: 6px; padding-top: 6px;
        border-top: 1px solid var(--border);
      }
      .roster-edit-link {
        background: none; border: none; color: var(--text-dim); font-size: 10.5px;
        letter-spacing: 0.4px; cursor: pointer; padding: 2px 4px;
      }
      .roster-edit-link:hover { color: var(--gold); }

      .rating-badge {
        display: flex; flex-direction: column; align-items: center; line-height: 1;
        flex-shrink: 0; padding: 0 4px;
      }
      .rating-badge-num { font-family: 'Anton', sans-serif; font-size: 21px; color: var(--gold); }
      .rating-badge-label { font-size: 8px; letter-spacing: 0.8px; color: var(--text-dim); margin-top: 3px; }

      .avatar { flex-shrink: 0; object-fit: cover; }
      .avatar-round { border-radius: 50%; }
      .avatar-square { border-radius: 15px; }
      .avatar-photo { border: 1.5px solid var(--border); }
      .avatar-fallback {
        background: var(--surface-2); border: 1.5px solid var(--border);
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; color: var(--text-dim);
      }

      .team-shield {
        display: inline-flex; align-items: center; justify-content: center;
        clip-path: polygon(50% 0%, 100% 20%, 100% 62%, 50% 100%, 0% 62%, 0% 20%);
        background: var(--shield-color); color: rgba(0,0,0,0.72); font-weight: 800;
        flex-shrink: 0;
      }

      .select-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
      .select-links { display: flex; gap: 12px; }
      .link { background: none; border: none; color: var(--gold); font-size: 13px; cursor: pointer; padding: 0; }
      .link-danger { color: var(--danger); }

      .admin-menu { position: relative; margin-bottom: 6px; }
      .admin-menu-trigger {
        display: flex; align-items: center; gap: 10px; width: 100%;
        background: linear-gradient(135deg, rgba(228,181,89,0.16), rgba(228,181,89,0.04) 60%), var(--surface-2);
        border: 1px solid rgba(228,181,89,0.4); border-radius: 16px;
        padding: 13px 16px; font-size: 14px; font-weight: 800; color: var(--text);
        cursor: pointer; text-align: left; letter-spacing: 0.2px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.25);
        transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;
      }
      .admin-menu-trigger:hover, .admin-menu-trigger.is-open {
        border-color: var(--gold); box-shadow: 0 6px 20px rgba(228,181,89,0.25);
      }
      .admin-menu-trigger:active { transform: scale(0.99); }
      .admin-menu-trigger:focus-visible {
        outline: none; border-color: var(--gold); box-shadow: 0 0 0 2px rgba(228,181,89,0.35);
      }
      .admin-menu-trigger-icon {
        font-size: 16px; width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        background: rgba(228,181,89,0.18); border: 1px solid rgba(228,181,89,0.35);
      }
      .admin-menu-trigger-caret {
        margin-left: auto; font-size: 9px; color: var(--gold); transition: transform 0.15s ease;
      }
      .admin-menu-panel {
        position: absolute; z-index: 40; top: calc(100% + 8px); left: 0; right: 0;
        display: flex; flex-direction: column; gap: 3px;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 18px;
        padding: 8px; box-shadow: 0 16px 40px rgba(0,0,0,0.5);
        max-height: 62vh; overflow-y: auto;
        animation: adminMenuPop 0.16s ease-out;
      }
      @keyframes adminMenuPop {
        from { opacity: 0; transform: translateY(-6px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .admin-menu-item {
        display: grid; grid-template-columns: 34px 1fr auto; align-items: center; gap: 12px;
        background: transparent; border: 1px solid transparent; border-radius: 12px;
        padding: 10px; font-size: 13.5px; font-weight: 600; color: var(--text);
        cursor: pointer; text-align: left; width: 100%;
        transition: background 0.12s ease, border-color 0.12s ease, transform 0.1s ease;
      }
      .admin-menu-item + .admin-menu-item-danger { margin-top: 6px; padding-top: 16px; position: relative; }
      .admin-menu-item + .admin-menu-item-danger::before {
        content: ""; position: absolute; top: 4px; left: 10px; right: 10px; height: 1px;
        background: var(--border);
      }
      .admin-menu-item-icon {
        font-size: 15px; text-align: center; width: 34px; height: 34px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        background: rgba(255,255,255,0.05);
      }
      .admin-menu-item-label { text-align: left; }
      .admin-menu-item:hover, .admin-menu-item:focus-visible {
        outline: none; background: rgba(228,181,89,0.12); border-color: rgba(228,181,89,0.3);
      }
      .admin-menu-item:active { transform: scale(0.99); }
      .admin-menu-item-danger { color: var(--danger); }
      .admin-menu-item-danger .admin-menu-item-icon { background: rgba(200,70,70,0.12); }
      @media (hover: hover) and (pointer: fine) {
        .admin-menu-item:hover { background: rgba(228,181,89,0.16); }
        .admin-menu-item-danger:hover { background: rgba(200,70,70,0.14); }
      }
      .admin-toolbar-hint { margin: 0 0 18px; }

      .presence-open-banner {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 4px; width: 100%; border: none; border-radius: 20px; cursor: pointer;
        padding: 22px 16px; margin-bottom: 24px;
        background: linear-gradient(135deg, var(--gold), #c98f2a);
        box-shadow: 0 0 0 0 rgba(228,181,89,0.5);
        animation: presence-banner-pulse 1.7s ease-in-out infinite;
      }
      .presence-open-banner-title {
        font-size: 22px; font-weight: 900; letter-spacing: 1px; color: #1a1406;
      }
      .presence-open-banner-cta {
        font-size: 13.5px; font-weight: 700; letter-spacing: 0.4px; color: #3a2c0a;
      }
      @keyframes presence-banner-pulse {
        0% { box-shadow: 0 0 0 0 rgba(228,181,89,0.6); transform: scale(1); }
        60% { box-shadow: 0 0 0 22px rgba(228,181,89,0); transform: scale(1.045); }
        100% { box-shadow: 0 0 0 0 rgba(228,181,89,0); transform: scale(1); }
      }

      .escalacao-banner {
        background: linear-gradient(135deg, var(--maroon-light), var(--maroon));
        animation: escalacao-banner-pulse 1.7s ease-in-out infinite;
      }
      .escalacao-banner .presence-open-banner-title,
      .escalacao-banner .presence-open-banner-cta { color: #fff; }
      @keyframes escalacao-banner-pulse {
        0% { box-shadow: 0 0 0 0 rgba(165,46,46,0.6); transform: scale(1); }
        60% { box-shadow: 0 0 0 22px rgba(165,46,46,0); transform: scale(1.045); }
        100% { box-shadow: 0 0 0 0 rgba(165,46,46,0); transform: scale(1); }
      }

      .escalacao-banner-concluded {
        background: linear-gradient(135deg, #8a8f96, #5f6469);
        animation: none;
        box-shadow: none;
      }
      .escalacao-banner-concluded-note {
        display: flex; align-items: center; justify-content: center; gap: 6px;
        margin-top: 6px; padding-top: 8px; width: 100%;
        border-top: 1px solid rgba(255,255,255,0.25);
        font-size: 12.5px; font-weight: 700; letter-spacing: 0.2px; color: #fff;
        text-align: center;
      }
      .escalacao-banner-check {
        display: inline-flex; align-items: center; justify-content: center;
        width: 16px; height: 16px; border-radius: 50%; background: #3fae5a;
        color: #fff; font-size: 10px; line-height: 1; flex-shrink: 0;
      }

      /* Banner da pelada extra — azul, pra não confundir com o da principal
         (dourado) nem com o da escalação (vermelho). */
      .extra-banner {
        background: linear-gradient(135deg, #3d8fd6, #245a8c);
        animation: extra-banner-pulse 1.7s ease-in-out infinite;
      }
      .extra-banner .presence-open-banner-title,
      .extra-banner .presence-open-banner-cta { color: #fff; }
      @keyframes extra-banner-pulse {
        0% { box-shadow: 0 0 0 0 rgba(61,143,214,0.6); transform: scale(1); }
        60% { box-shadow: 0 0 0 22px rgba(61,143,214,0); transform: scale(1.045); }
        100% { box-shadow: 0 0 0 0 rgba(61,143,214,0); transform: scale(1); }
      }

      .escalacao-modal { max-height: 85vh; overflow-y: auto; padding: 24px 20px; }
      .escalacao-teams { display: flex; flex-direction: column; gap: 16px; margin: 18px 0; }
      .escalacao-teams .team-card { margin-bottom: 0; padding: 16px 18px; }
      .escalacao-modal-actions {
        display: flex; flex-direction: column; gap: 10px; margin-top: 20px;
        padding-top: 16px; border-top: 1px solid var(--border);
      }
      .escalacao-modal-actions .link-danger { text-align: center; }

      .presence-list-modal { max-height: 85vh; overflow-y: auto; }

      .select-grid { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .select-card {
        display: flex; align-items: center; gap: 10px; background: var(--surface);
        border: 1px solid var(--border); border-radius: 14px; padding: 8px 12px; cursor: pointer; position: relative;
      }
      .select-card-on { border-color: var(--gold); background: var(--gold-soft); box-shadow: 0 4px 14px rgba(240,204,60,0.1); }
      .select-card-info { display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 2px; }
      .select-card-name { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .select-card-fullname { font-size: 10.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .select-card-sub { font-size: 11px; color: var(--text-dim); }
      .select-card-rating { font-family: 'Anton', sans-serif; font-size: 16px; color: var(--gold); flex-shrink: 0; }
      .check {
        width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--border);
        display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--bg); flex-shrink: 0;
      }
      .check-on { background: var(--gold); border-color: var(--gold); }

      .config-block { margin-bottom: 22px; }
      .config-title {
        font-family: 'Anton', sans-serif; font-weight: 400; font-size: 18px; letter-spacing: 0.3px; margin: 0 0 10px;
      }
      .config-hint { font-size: 12px; color: var(--text-dim); margin: 8px 2px 0; }

      .segmented { display: flex; gap: 8px; }
      .segmented-sm .segmented-opt { padding: 9px 14px; font-size: 13px; }
      .segmented-opt {
        flex: 1; background: var(--surface); border: 1px solid var(--border); color: var(--text);
        border-radius: 12px; padding: 12px; font-weight: 600; cursor: pointer; font-size: 14px;
        transition: border-color .12s ease, background .12s ease;
      }
      .segmented-opt-on { border-color: var(--gold); background: var(--gold-soft); color: var(--gold); }
      .segmented-opt:disabled { opacity: 0.3; cursor: not-allowed; }
      .segmented-sm .segmented-opt:first-child.segmented-opt-on { border-color: var(--maroon-light); background: var(--maroon-soft); color: #ff9a9a; }

      .switch-row { display: flex; align-items: center; justify-content: space-between; margin: 14px 0; font-size: 14px; }
      .toggle {
        width: 42px; height: 24px; border-radius: 999px; background: var(--surface-2);
        border: 1px solid var(--border); position: relative; cursor: pointer; padding: 0;
      }
      .toggle-knob {
        position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
        background: var(--text-dim); transition: transform .15s ease, background .15s ease;
      }
      .toggle-on { border-color: var(--gold); }
      .toggle-on .toggle-knob { transform: translateX(18px); background: var(--gold); }

      .method-list { display: flex; flex-direction: column; gap: 8px; }
      .method-card {
        display: flex; align-items: center; gap: 12px; text-align: left;
        background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
        padding: 12px 14px; cursor: pointer; color: var(--text);
        transition: border-color .12s ease, background .12s ease;
      }
      .method-card-on { border-color: var(--gold); background: var(--gold-soft); }
      .method-icon { font-size: 20px; }
      .method-name { display: block; font-weight: 600; font-size: 14px; }
      .method-desc { display: block; font-size: 12px; color: var(--text-dim); margin-top: 2px; }

      .rule-builder { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 12px; }
      .rule-pickers { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
      .rule-symbol { font-size: 16px; }
      .rule-list { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .rule-row {
        display: flex; align-items: center; justify-content: space-between; font-size: 13px;
        background: var(--surface-2); border-radius: 10px; padding: 8px 12px;
      }

      .rules-section-label {
        font-size: 12.5px; font-weight: 700; letter-spacing: 0.3px; color: var(--text-dim);
        margin: 0 0 8px;
      }
      .rules-section-label-spaced { margin-top: 18px; }
      .separate-group-box {
        background: var(--maroon-soft); border: 1px solid var(--maroon-light);
        border-radius: 14px; padding: 12px; margin-bottom: 10px;
      }
      .separate-group-title {
        font-family: 'Anton', sans-serif; font-size: 13px; letter-spacing: 0.4px;
        color: #ff9a9a; text-transform: uppercase;
      }
      .separate-group-slots { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
      .separate-group-hint { font-size: 11.5px; color: var(--text-dim); margin: 8px 0 0; }

      .input {
        width: 100%; background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
        border-radius: 10px; padding: 11px 12px; font-size: 16px; font-family: inherit;
      }
      .field-label { display: block; font-size: 13px; color: var(--text-dim); margin: 14px 0 6px; }
      .field-hint { font-size: 11.5px; color: var(--text-dim); margin: 6px 2px 0; line-height: 1.4; }
      .slider { width: 100%; accent-color: var(--gold); }

      .error-text { color: var(--danger); font-size: 13px; margin: 10px 2px; line-height: 1.5; }
      .info-banner {
        background: var(--gold-soft); border: 1px solid var(--gold-dark); color: var(--gold);
        border-radius: 12px; padding: 10px 14px; font-size: 13px; margin-bottom: 16px;
      }

      .team-card {
        background: var(--surface); border: 1px solid var(--border); border-radius: 18px;
        padding: 14px 16px; margin-bottom: 12px; border-top: 3px solid var(--team-color);
      }
      .team-card-head { margin-bottom: 8px; }
      .team-card-title {
        font-family: 'Anton', sans-serif; font-weight: 400; font-size: 18px;
        letter-spacing: 0.4px; color: var(--team-color);
      }
      .team-player-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
      .team-player-row { display: flex; align-items: center; gap: 10px; }
      .team-player-name { flex: 1; font-size: 14px; font-weight: 500; }
      .team-card-foot {
        margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border);
        font-size: 13px; color: var(--text-dim); font-weight: 600;
      }

      .balance-card {
        background: var(--surface); border: 1px solid var(--border); border-radius: 18px;
        padding: 16px; text-align: center; margin: 6px 0 18px;
      }
      .balance-card .stars { font-size: 20px; }
      .balance-label {
        font-family: 'Anton', sans-serif; font-weight: 400; font-size: 21px; margin: 4px 0 10px; color: var(--gold);
      }
      .balance-detail { font-size: 12px; color: var(--text-dim); margin: 3px 0; }

      .result-actions { display: flex; gap: 10px; }
      .publish-btn { margin-top: 10px; }
      .publish-hint { text-align: center; margin-top: 8px; margin-bottom: 4px; }

      .published-section { margin-bottom: 24px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
      .published-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .published-title {
        font-family: 'Anton', sans-serif; font-weight: 400; font-size: 18px;
        letter-spacing: 0.3px; color: var(--gold);
      }

      /* Nome de exibição (apelido) sempre em caixa alta; nome completo em
         formatação normal (primeira letra de cada palavra maiúscula) — reforço
         via CSS além da formatação já aplicada ao salvar, pra cobrir também
         cadastros antigos. */
      .roster-name, .select-card-name, .team-player-name, .profile-hero-name-text,
      .featured-card-name, .presence-name, .account-card-preview .roster-name {
        text-transform: uppercase;
      }
      .roster-fullname, .select-card-fullname, .profile-hero-fullname, .featured-card-fullname,
      .account-card-preview .roster-fullname {
        text-transform: capitalize;
      }

      .presence-section {
        margin-bottom: 24px; padding: 18px 16px 20px; border-radius: 18px;
        background: linear-gradient(165deg, var(--surface), var(--surface-2));
        border: 1px solid var(--border);
        box-shadow: 0 10px 28px rgba(0,0,0,0.28);
      }
      .presence-meta { font-size: 13px; color: var(--text-dim); margin: 0 0 12px; text-transform: capitalize; }
      .suggestion-list {
        list-style: none; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column;
        gap: 10px; max-height: 50vh; overflow-y: auto;
      }
      .suggestion-item {
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px;
        padding: 10px 12px;
      }
      .suggestion-item-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .suggestion-item-author { font-size: 13.5px; font-weight: 700; color: var(--gold); }
      .suggestion-item-date { font-size: 11px; color: var(--text-dim); flex-shrink: 0; }
      .suggestion-item-email { font-size: 11.5px; color: var(--text-dim); margin-top: 1px; }
      .suggestion-item-message { font-size: 13.5px; margin: 8px 0; line-height: 1.4; white-space: pre-wrap; }
      .suggestion-form { margin-top: 14px; }
      .suggestion-form textarea {
        width: 100%; min-height: 80px; resize: vertical; font-family: inherit; font-size: 13.5px;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px;
        padding: 10px 12px; color: var(--text);
      }
      .presence-list { list-style: none; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .presence-row {
        display: flex; align-items: center; gap: 10px; padding: 6px 0 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .presence-row:last-child { border-bottom: none; }
      .presence-name { flex: 1; font-size: 14px; font-weight: 600; }
      .presence-name-clickable { cursor: pointer; touch-action: manipulation; }
      .presence-name-clickable:hover, .presence-name-clickable:active { color: var(--gold); }
      .presence-avulso-tag { font-size: 11px; font-weight: 600; color: var(--gold); text-transform: none; }
      .presence-by-tag { font-size: 10.5px; font-weight: 500; color: var(--text-dim); text-transform: none; }

      .app-footer {
        width: 100%; text-align: center; margin-top: 28px; padding-bottom: 4px;
        font-size: 10.5px; color: var(--text-dim); opacity: 0.45; letter-spacing: 0.2px;
      }

      .finance-modal { max-width: 520px; }
      .finance-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .finance-row {
        display: flex; align-items: center; gap: 10px; padding: 8px 10px;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px;
      }
      .finance-row-label { flex: 1; font-size: 13px; }
      .finance-row-amount { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .finance-in { color: #6fcf7a; }
      .finance-out { color: var(--danger); }
      .finance-subtotal {
        text-align: right; font-size: 12.5px; color: var(--text-dim); margin: 8px 2px 18px;
      }
      .finance-add-row { display: flex; gap: 8px; margin: 12px 0 4px; flex-wrap: wrap; }
      .finance-add-row .input { flex: 2; min-width: 140px; }
      .finance-amount-input { flex: 1; min-width: 90px; }
      .finance-final-box {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        margin-top: 16px; padding: 14px 16px; border-radius: 14px;
        background: var(--surface-2); border: 1px solid var(--border);
        font-weight: 700; font-size: 14px;
      }
      .finance-final-box span:last-child { font-variant-numeric: tabular-nums; font-size: 16px; }
      /* Recebimentos por mês → mensalidades + avulsos por pelada */
      .finance-month {
        margin: 8px 0; border: 1px solid var(--border); border-radius: 14px;
        background: var(--surface); padding: 0 10px 10px;
      }
      .finance-month-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 12px 4px 4px; cursor: pointer; list-style: none;
        font-weight: 800; font-size: 14.5px; font-variant-numeric: tabular-nums;
      }
      .finance-month-head::-webkit-details-marker { display: none; }
      .finance-month-head::before { content: "▸"; color: var(--gold); margin-right: 2px; }
      .finance-month[open] > .finance-month-head::before { content: "▾"; }
      .finance-month-head span:first-child { flex: 1; }
      .finance-section-title {
        margin: 12px 2px 2px; font-size: 11.5px; font-weight: 700; letter-spacing: 1px;
        text-transform: uppercase; color: var(--gold);
      }
      .finance-pelada { margin-top: 8px; }
      .finance-pelada-title {
        display: flex; align-items: center; gap: 8px; margin: 6px 2px 0;
        font-size: 12.5px; font-weight: 700; color: var(--text);
      }
      .finance-pelada-total {
        margin-left: auto; color: #6fcf7a; font-variant-numeric: tabular-nums;
      }
      .finance-income-row { flex-direction: column; align-items: stretch; gap: 3px; }
      .finance-row-main { display: flex; align-items: center; gap: 10px; }
      .finance-paid-pill { font-size: 10.5px; padding: 3px 8px; cursor: default; }
      .finance-row-sub {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        font-size: 11px; color: var(--text-dim);
      }
      .finance-edit-link { padding: 0; font-size: 11.5px; }
      .finance-row-edit {
        display: flex; flex-direction: column; gap: 8px; margin-top: 6px;
        padding-top: 8px; border-top: 1px dashed var(--border);
      }
      .finance-row-edit .link { align-self: flex-start; padding: 0; font-size: 12px; }

      /* PIX vinculado a um caixa */
      .pix-active-owner { margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--gold); }
      .finance-month-caixa {
        margin: 4px 0 16px; padding: 12px; border-radius: 14px;
        background: var(--gold-soft); border: 1px solid var(--gold);
      }
      .finance-month-caixa-label {
        display: block; margin-bottom: 6px; font-size: 12px; font-weight: 800;
        letter-spacing: 1px; text-transform: uppercase; color: var(--gold);
      }
      .finance-month-caixa .field-hint { margin: 6px 0 0; }
      .pix-missing-key { color: var(--danger); font-weight: 600; }
      .pix-edit-row .input { margin-bottom: 6px; }

      .finance-final-box-geral {
        margin-top: 10px;
        background: linear-gradient(135deg, rgba(228,181,89,0.16), rgba(228,181,89,0.05));
        border-color: rgba(228,181,89,0.4); color: var(--gold);
      }
      .presence-num {
        font-size: 12.5px; font-weight: 700; font-variant-numeric: tabular-nums;
        width: 22px; height: 22px; line-height: 22px; text-align: center; flex-shrink: 0;
        border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border);
        color: var(--text-dim);
      }
      .presence-remove { font-size: 12px; }
      .presence-add-row { display: flex; gap: 8px; margin-top: 14px; }
      .presence-add-row .input { flex: 1; }
      .presence-add-search { margin-top: 14px; margin-bottom: 0; }
      .presence-promote-btn { font-size: 12px; }
      .presence-my-actions { display: flex; gap: 10px; margin: 4px 0 16px; }
      .presence-my-actions .btn:first-child {
        flex: 7; font-size: 16px; padding: 17px 16px; border-radius: 16px; letter-spacing: 0.4px;
      }
      .presence-my-actions .btn:last-child { flex: 3; }
      .presence-group-title {
        font-family: 'Inter', sans-serif; font-weight: 800; font-size: 13px; text-transform: uppercase;
        letter-spacing: 0.5px; color: rgba(255,255,255,0.88); margin: 22px 2px 10px;
      }
      .presence-share-btn { margin-top: 18px; }

      /* ---- Linhas em formato cartão (página da lista de presença) ----
         Cada grupo (GOLEIROS / CONFIRMADOS / AVULSOS / M.AUSENTES) é UMA
         caixa só, com as linhas separadas por divisor fino dentro dela —
         não uma caixa por jogador. */
      .presence-card-list {
        list-style: none; margin: 0; padding: 4px 14px;
        background: rgba(255,255,255,0.025); border: 1px solid var(--border); border-radius: 18px;
      }
      .presence-card-row { padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.07); }
      .presence-card-row:last-child { border-bottom: none; }
      .presence-card-top { display: flex; align-items: center; gap: 12px; }
      .presence-card-num {
        font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums;
        width: 20px; height: 20px; line-height: 20px; text-align: center; flex-shrink: 0;
        border-radius: 999px; background: var(--surface); border: 1px solid var(--border);
        color: var(--text-dim);
      }
      .presence-card-guest-avatar { width: 40px; height: 40px; font-size: 14px; flex-shrink: 0; }
      .presence-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .presence-card-main-clickable { cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
      .presence-card-main-clickable:hover .presence-card-name,
      .presence-card-main-clickable:active .presence-card-name { color: var(--gold); }
      .presence-card-name {
        font-size: 13.5px; font-weight: 800; letter-spacing: 0.2px; text-transform: uppercase;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .presence-card-sub { font-size: 11.5px; font-weight: 600; color: var(--text-dim); letter-spacing: 0.3px; }
      .presence-card-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
      .presence-card-status {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 11.5px; font-weight: 800; letter-spacing: 0.3px; padding: 8px 14px;
        border-radius: 999px; white-space: nowrap;
      }
      .presence-card-status-icon { font-size: 11px; }
      .presence-card-status-green { background: rgba(111,207,122,0.16); color: #6fcf7a; }
      .presence-card-status-yellow { background: var(--gold-soft); color: var(--gold); }
      .presence-card-status-red { background: rgba(232,101,109,0.16); color: var(--danger); }
      .presence-card-chevron { font-size: 20px; color: var(--text-dim); line-height: 1; }
      .presence-card-admin-row {
        display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
        margin: 10px 0 0 60px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.08);
      }
      .presence-card-bytag { font-size: 10.5px; font-weight: 500; color: var(--text-dim); }

      .history-item { border-bottom: 1px solid var(--border); padding: 10px 0; }
      .history-item:last-of-type { border-bottom: none; }
      .history-summary {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        cursor: pointer; font-size: 13px; font-weight: 600; list-style: none;
      }
      .history-summary::-webkit-details-marker { display: none; }
      .history-counts { font-size: 12px; color: var(--text-dim); font-weight: 500; flex-shrink: 0; }
      .history-kind-badge {
        display: inline-block; font-size: 9px; font-weight: 800; letter-spacing: 0.4px;
        padding: 2px 6px; border-radius: 999px; background: var(--gold-soft); color: var(--gold);
        margin-right: 6px; vertical-align: middle;
      }
      .history-kind-badge-deleted { background: rgba(232,101,109,0.14); color: var(--danger); }
      .history-reopen-btn { margin-top: 8px; font-size: 12.5px; padding: 8px 12px; }

      .account-tabs { display: flex; gap: 6px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
      .account-tab {
        flex: 1; background: none; border: none; color: var(--text-dim); font-size: 13px;
        font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; padding: 10px 4px;
        cursor: pointer; border-bottom: 2px solid transparent;
      }
      .account-tab-active { color: var(--gold); border-bottom-color: var(--gold); }
      .account-card-preview {
        display: flex; align-items: center; gap: 12px; margin: 4px 0 16px;
        padding: 10px; background: var(--surface-2); border-radius: 14px;
      }
      .account-forgot-link { display: block; margin: -6px 0 14px; font-size: 12.5px; }

      .modal-backdrop {
        position: fixed; inset: 0; background: rgba(5,4,3,0.78); display: flex;
        align-items: flex-end; justify-content: center; z-index: 50; padding: 0;
      }
      .modal {
        background: var(--surface); border: 1px solid var(--border); border-radius: 22px 22px 0 0;
        width: 100%; max-width: 480px; padding: 22px 20px calc(28px + env(safe-area-inset-bottom)); max-height: 88vh; overflow-y: auto;
        position: relative;
      }
      .modal-title { font-family: 'Anton', sans-serif; font-weight: 400; font-size: 21px; margin: 0 0 16px; }
      .modal-actions { display: flex; gap: 8px; margin-top: 18px; align-items: center; }
      .spacer { flex: 1; }
      .photo-row { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
      .photo-actions { display: flex; flex-direction: column; gap: 6px; }

      .cover-slots { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 4px; }
      .cover-slot { position: relative; flex: 0 1 72px; width: 72px; }
      .cover-slot-thumb {
        width: 100%; aspect-ratio: 1; border-radius: 14px; border: 1.5px dashed var(--border);
        background: var(--surface-2); display: flex; align-items: center; justify-content: center;
        padding: 0; overflow: hidden; cursor: pointer;
      }
      .cover-slot-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .cover-slot-plus { color: var(--text-dim); font-size: 24px; }
      .cover-slot-uploading { color: var(--gold); font-size: 20px; animation: pulseUpload 1s ease-in-out infinite; }

      .reframe-box {
        position: relative; width: 220px; height: 220px; margin: 4px auto 18px;
        border-radius: 16px; overflow: hidden; background: var(--surface-2);
        cursor: grab; touch-action: none; user-select: none;
      }
      .reframe-box:active { cursor: grabbing; }
      .reframe-img { width: 100%; height: 100%; object-fit: cover; pointer-events: none; display: block; }
      .reframe-circle-mask {
        position: absolute; inset: 0; border-radius: 50%;
        box-shadow: 0 0 0 9999px rgba(10,9,8,0.6), inset 0 0 0 2px var(--gold);
        pointer-events: none;
      }
      @keyframes pulseUpload { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
      .cover-slot-remove {
        position: absolute; top: -6px; right: -6px; width: 22px; height: 22px; border-radius: 50%;
        background: var(--maroon-light); color: #fff; border: 1.5px solid var(--surface);
        font-size: 14px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
      }
      .cover-slot-reframe {
        position: absolute; bottom: -6px; right: -6px; width: 22px; height: 22px; border-radius: 50%;
        background: var(--gold); color: #221a0d; border: 1.5px solid var(--surface);
        font-size: 12px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
      }

      .share-textarea { min-height: 220px; font-family: monospace; font-size: 13px; white-space: pre-wrap; }

      /* ---- perfil do jogador: capa em tela cheia + painel sobreposto ---- */
      .modal.profile-modal { padding: 0; overflow: hidden; overflow-y: auto; }

      .profile-hero {
        position: relative; width: 100%; height: 380px; overflow: hidden;
        border-radius: 22px 22px 0 0; background: var(--surface-2); flex-shrink: 0;
      }
      .hero-crossfade-layer {
        position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
        opacity: 0; transition: opacity 0.9s ease;
      }
      .hero-layer-on { opacity: 1; z-index: 1; }
      .hero-layer-off { opacity: 0; z-index: 0; }
      .hero-carousel-nav {
        position: absolute; top: 50%; transform: translateY(-50%); z-index: 2;
        width: 34px; height: 34px; border-radius: 50%; background: rgba(10,9,8,0.4);
        border: 1px solid rgba(255,255,255,0.14); color: #fff; opacity: 0.4;
        display: flex; align-items: center; justify-content: center; font-size: 20px;
        line-height: 1; cursor: pointer; touch-action: manipulation; transition: opacity 0.2s ease;
      }
      .hero-carousel-nav:hover, .hero-carousel-nav:active { opacity: 0.9; }
      .hero-carousel-nav-prev { left: 10px; }
      .hero-carousel-nav-next { right: 10px; }
      .profile-hero-fallback {
        width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
        font-family: 'Anton', sans-serif; font-size: 88px; color: rgba(255,255,255,0.92);
      }
      .profile-hero-scrim {
        position: absolute; inset: 0; z-index: 1;
        background: linear-gradient(180deg, rgba(10,9,8,0) 38%, rgba(10,9,8,0.92) 100%);
      }
      .profile-hero-icons {
        position: absolute; top: 14px; left: 14px; right: 14px; z-index: 2;
        display: flex; justify-content: space-between;
      }
      .hero-icon-btn {
        width: 42px; height: 42px; border-radius: 50%; background: rgba(10,9,8,0.55);
        backdrop-filter: blur(4px); border: 1px solid rgba(255,255,255,0.18); color: #fff;
        display: flex; align-items: center; justify-content: center; font-size: 18px; cursor: pointer;
        touch-action: manipulation;
      }
      .hero-icon-btn:hover { border-color: var(--gold); color: var(--gold); }
      .profile-hero-name {
        position: absolute; left: 18px; right: 18px; bottom: 14px; z-index: 2;
        display: flex; flex-direction: column; gap: 6px;
      }
      .profile-hero-name-row { display: flex; align-items: center; gap: 14px; }
      .profile-hero-name-row .avatar { border: 3px solid var(--gold); flex-shrink: 0; box-shadow: 0 4px 16px rgba(0,0,0,0.5); }
      .profile-hero-name-col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .profile-hero-name-text {
        font-family: 'Anton', sans-serif; font-size: 28px; color: #fff; letter-spacing: 0.3px;
        text-shadow: 0 2px 10px rgba(0,0,0,0.5); line-height: 1.05;
      }
      .profile-hero-fullname {
        font-size: 13px; color: rgba(255,255,255,0.75); text-shadow: 0 1px 6px rgba(0,0,0,0.5);
      }
      .profile-hero-name .stars { font-size: 16px; }
      .fav-team-crest-img { object-fit: contain; flex-shrink: 0; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4)); }
      .admin-status { font-size: 14px; color: var(--gold); margin: 4px 0 4px; }
      .admin-hint { font-size: 13px; color: var(--text-dim); margin: 0 0 14px; line-height: 1.5; }

      .profile-panel { padding: 18px 20px 24px; }
      .profile-stats {
        display: flex; justify-content: space-around; padding-bottom: 16px;
        margin-bottom: 16px; border-bottom: 1px solid var(--border);
      }
      .profile-stat { display: flex; flex-direction: column; align-items: center; gap: 4px; }
      .profile-stat-value { font-family: 'Anton', sans-serif; font-size: 17px; color: var(--gold); white-space: nowrap; }
      .profile-stat-label { font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--text-dim); }

      .profile-fav-team { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
      .profile-fav-team-text { display: flex; flex-direction: column; text-align: left; }
      .profile-fav-team-label { font-size: 10.5px; letter-spacing: 0.5px; color: var(--text-dim); }
      .profile-fav-team-name { font-size: 14px; font-weight: 600; }

      .fav-team-trigger {
        display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 14px;
        padding: 10px 14px; cursor: pointer; margin-bottom: 4px;
      }
      .fav-team-trigger-name { flex: 1; font-size: 14.5px; font-weight: 700; color: var(--text); }
      .fav-team-trigger-placeholder { flex: 1; font-size: 14px; color: var(--text-dim); }
      .fav-team-trigger-caret { color: var(--text-dim); font-size: 12px; }
      .fav-team-other-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 32px; height: 32px; font-size: 18px; flex-shrink: 0;
      }
      .fav-team-sheet { display: flex; flex-direction: column; gap: 4px; }
      .fav-team-options { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
      .fav-team-option {
        display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px;
        padding: 10px 14px; font-size: 14.5px; font-weight: 600; color: var(--text); cursor: pointer;
      }
      .fav-team-option:hover { border-color: var(--gold); }
      .fav-team-option-active { border-color: var(--gold); background: rgba(228,181,89,0.1); }
      .fav-team-custom {
        display: flex; align-items: center; gap: 10px; margin-top: 10px;
        background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px; padding: 8px 10px;
      }
      .fav-team-custom .input { flex: 1; }

      .instagram-link {
        display: inline-flex; align-items: center; gap: 4px; color: inherit; text-decoration: none;
        width: fit-content; line-height: 1;
      }
      .instagram-link:hover { color: var(--gold); }
      .profile-hero-instagram { font-size: 12.5px; color: rgba(244,241,234,0.85); margin-top: 2px; }
      /* Área de toque menor de propósito — ficava fácil demais de abrir o
         Instagram sem querer ao tentar tocar em outra parte do card. */
      .roster-instagram { font-size: 10px; color: var(--text-dim); margin-top: 3px; }
      .roster-instagram svg { width: 12px; height: 12px; }
      .roster-instagram:hover { color: var(--gold); }

      .profile-admin-contact {
        display: flex; flex-direction: column; gap: 2px; margin-bottom: 18px;
        padding: 10px 12px; background: var(--surface-2); border-radius: 12px;
      }
      .profile-admin-contact-label { font-size: 10.5px; letter-spacing: 0.4px; color: var(--text-dim); }
      .profile-admin-contact-value { font-size: 15px; font-weight: 600; color: var(--gold); text-decoration: none; }

      .profile-cta { margin-bottom: 10px; }
      .profile-close-link { display: block; width: 100%; text-align: center; color: var(--text-dim); font-size: 13px; }

      .toast {
        position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
        background: linear-gradient(180deg, #ffe27a 0%, var(--gold) 100%); color: #241a06;
        padding: 10px 20px; border-radius: 999px;
        font-size: 13px; font-weight: 700; z-index: 60; box-shadow: 0 6px 20px rgba(0,0,0,0.5);
      }

      .featured-carousel {
        position: relative; width: 100%; height: 180px; border-radius: 18px;
        overflow: hidden; margin: 16px 0 18px; border: 1px solid var(--border); background: var(--surface-2);
      }
      .featured-layer { position: absolute; inset: 0; opacity: 0; transition: opacity 0.9s ease; }
      .featured-layer-on { opacity: 1; z-index: 2; }
      .featured-layer-off { opacity: 0; z-index: 1; }
      .featured-card { position: relative; width: 100%; height: 100%; cursor: pointer; }
      .featured-card:focus-visible { outline: none; box-shadow: inset 0 0 0 3px var(--gold); }
      @media (hover: hover) and (pointer: fine) {
        .featured-card:hover .featured-card-photo,
        .featured-card:hover .featured-card-fallback { filter: brightness(1.08); transform: scale(1.02); }
        .featured-card-photo, .featured-card-fallback { transition: transform 0.2s ease, filter 0.2s ease; }
      }
      .featured-card-photo { width: 100%; height: 100%; object-fit: cover; display: block; }
      .featured-card-fallback {
        width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
        font-family: 'Anton', sans-serif; font-size: 54px; color: rgba(255,255,255,0.92);
      }
      .featured-card-badge {
        position: absolute; top: 12px; left: 12px; background: rgba(10,9,8,0.6); backdrop-filter: blur(4px);
        border: 1px solid rgba(255,255,255,0.18); color: var(--gold); font-size: 11px; font-weight: 700;
        padding: 4px 10px; border-radius: 999px; letter-spacing: 0.3px;
        display: flex; align-items: center; gap: 6px;
      }
      .featured-card-badge-name {
        color: #fff; font-weight: 600; padding-left: 6px; border-left: 1px solid rgba(255,255,255,0.25);
      }

      .rules-page { min-height: 100dvh; min-height: 100vh; background: var(--bg); }
      .rules-page-header {
        position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px;
        /* Desce o cabeçalho abaixo da barra de status do iPhone (relógio,
           bateria) — sem isso o botão voltar e o título ficavam por baixo dela. */
        padding: max(14px, calc(env(safe-area-inset-top) + 8px)) 16px 14px;
        background: rgba(10,9,8,0.92); backdrop-filter: blur(6px);
        border-bottom: 1px solid var(--border);
      }
      .rules-page-title {
        margin: 0; font-family: 'Anton', 'Barlow Condensed', sans-serif; font-weight: 400;
        font-size: 19px; letter-spacing: 0.5px; color: var(--gold);
      }
      .rules-page-body { max-width: 640px; margin: 0 auto; padding: 20px 18px 48px; }
      .rules-meta { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
      .rules-meta-line { margin: 0; font-size: 14px; color: var(--text); }
      .rules-updated {
        margin: 0 0 18px; font-size: 12px; font-weight: 700; letter-spacing: 0.4px;
        color: var(--gold-dark);
      }
      .rules-list { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 14px; }
      .rules-item { font-size: 14.5px; line-height: 1.5; color: var(--text); }
      .rules-item strong { color: var(--gold); font-weight: 700; }
      .rules-contact {
        margin: 22px 0 4px; padding: 14px; border-radius: 12px; background: var(--surface-2);
        border: 1px solid var(--border); font-size: 14px; line-height: 1.5;
      }
      .rules-contact strong { color: var(--gold); font-weight: 700; }
      .rules-signature { margin: 10px 0 0; font-size: 12px; color: var(--text-dim); text-align: right; }

      /* ---- Página própria da Lista de Presença ---- */
      .presence-auto-tag {
        display: inline-block; margin-left: 8px; padding: 2px 6px; border-radius: 6px;
        font-family: inherit; font-size: 9px; font-weight: 700; letter-spacing: 0.04em;
        line-height: 1.2; vertical-align: middle; color: var(--muted, #a89f94);
        border: 1px solid var(--border); background: rgba(255,255,255,0.05);
      }
      .presence-page { min-height: 100dvh; min-height: 100vh; background: var(--bg); width: 100%; }
      .presence-page-header {
        position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px;
        padding: max(16px, calc(env(safe-area-inset-top) + 8px)) 20px 16px;
        background: rgba(10,9,8,0.92); backdrop-filter: blur(6px);
      }
      .presence-page-title {
        flex: 1; margin: 0; font-family: 'Inter', sans-serif; font-weight: 800;
        font-size: 21px; letter-spacing: 0.1px; color: var(--text);
      }
      .presence-page-date { display: flex; align-items: center; gap: 8px; }
      .presence-page-date-icon {
        width: 38px; height: 38px; border-radius: 11px; background: var(--surface-2);
        border: 1px solid var(--border); display: flex; align-items: center; justify-content: center;
        color: var(--text); flex-shrink: 0;
      }
      .presence-page-date-text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; }
      .presence-page-date-num { font-size: 13px; font-weight: 800; color: var(--text); }
      .presence-page-date-day { font-size: 9.5px; font-weight: 600; letter-spacing: 0.4px; color: var(--text-dim); }
      .presence-page-menu-btn {
        width: 32px; height: 32px; border-radius: 999px; background: transparent; border: none;
        color: var(--text-dim); font-size: 20px; font-weight: 700; line-height: 1; cursor: pointer;
        display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      }
      .presence-page-menu-btn:hover { color: var(--text); }

      .presence-page-card {
        width: calc(100% - 32px); max-width: 640px; margin: 14px auto 0;
        padding: 14px 16px; border-radius: 20px; overflow: hidden;
        background-color: var(--bg);
        background-image:
          linear-gradient(100deg, rgba(8,7,6,0.94) 0%, rgba(8,7,6,0.8) 42%, rgba(8,7,6,0.48) 68%, rgba(8,7,6,0.16) 100%),
          url('${STADIUM_BALL_DATA_URL}');
        background-repeat: no-repeat, no-repeat;
        background-size: cover, cover;
        background-position: center, 82% 84%;
        border: 1px solid var(--border);
      }
      .presence-page-card-head { display: flex; align-items: flex-start; gap: 12px; }
      .presence-page-logo { width: 140px; height: 140px; object-fit: contain; flex-shrink: 0; }
      .presence-page-card-headcol { flex: 1; min-width: 0; padding-top: 4px; }
      .presence-page-card-title {
        margin: 0 0 8px; font-family: 'Anton', 'Barlow Condensed', sans-serif; font-weight: 400;
        font-size: 22px; letter-spacing: 0.4px; color: #fff;
      }
      .presence-page-card-info { display: flex; flex-direction: column; gap: 6px; }
      .presence-page-card-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
      .presence-page-card-icon {
        width: 20px; height: 20px; border-radius: 6px; background: rgba(255,255,255,0.14);
        display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0;
      }
      .presence-page-card-icon svg { width: 10px; height: 10px; }
      .presence-page-card-value {
        font-size: 11px; font-weight: 800; color: #fff; letter-spacing: 0.1px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      .escalacao-header-card { width: 100%; max-width: none; margin: 0 0 16px; }

      .presence-page-stats {
        display: flex; align-items: stretch; width: calc(100% - 32px); max-width: 640px; margin: 14px auto 0;
        padding: 10px 6px; border-radius: 16px; background: rgba(255,255,255,0.025); border: 1px solid var(--border);
      }
      .presence-stat {
        flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
      }
      .presence-stat:not(:first-child) { border-left: 1px solid var(--border); }
      .presence-stat-top { display: flex; align-items: center; gap: 5px; }
      .presence-stat-icon { width: 18px; height: 18px; }
      .presence-stat-num { font-size: 17px; font-weight: 800; line-height: 1.1; }
      .presence-stat-label { font-size: 8.5px; font-weight: 700; letter-spacing: 0.3px; color: var(--text-dim); }
      .presence-stat-green .presence-stat-icon { color: #6fcf7a; }
      .presence-stat-yellow .presence-stat-icon { color: var(--gold); }
      .presence-stat-red .presence-stat-icon { color: var(--danger); }
      .presence-stat-green .presence-stat-num { color: #6fcf7a; }
      .presence-stat-yellow .presence-stat-num { color: var(--gold); }
      .presence-stat-red .presence-stat-num { color: var(--danger); }

      .presence-page-body { max-width: 640px; margin: 0 auto; padding: 16px 16px 48px; }

      @media (min-width: 520px) {
        .pelada-root { padding-top: 12px; }
      }

      /* ===== TEMA CARVÃO · OURO · BRANCO · BORDÔ (alertas: laranja + preto) ===== */
      .pelada-root {
        --bg: #1c1d20;
        --surface: #27292d;
        --surface-2: #2f3237;
        --border: #3d4046;
        --text: #ffffff;
        --text-dim: #a7a9ae;
        --gold: #e9b949;
        --gold-dark: #b98a24;
        --gold-soft: rgba(233,185,73,0.12);
        --maroon: #8a1430;
        --maroon-light: #c63a5a;
        --maroon-soft: rgba(198,58,90,0.16);
        --danger: #e0607c;
        --alert: #ff7a00;
        --alert-dark: #8a3f00;
        --cut: 10px;
      }
      .stadium-photo { filter: grayscale(.85) brightness(.32) contrast(1.05); opacity: .55; }
      .stadium-glow { opacity: .35; }
      .floating-logo { opacity: 0.07; }
      .stadium-vignette {
        background:
          radial-gradient(circle at 20% 6%, rgba(233,185,73,0.12), transparent 40%),
          linear-gradient(180deg, rgba(28,29,32,0.55) 0%, rgba(28,29,32,0.78) 40%, rgba(28,29,32,0.96) 100%);
      }
      .pelada-root h1, .pelada-root h2, .config-title { font-family: 'Anton','Barlow Condensed',sans-serif; text-transform: uppercase; letter-spacing: 1px; }
      .topbar-divider { background: linear-gradient(90deg, transparent, var(--gold), transparent) !important; height: 2px; }
      .topbar-caption { color: var(--text-dim); font-family: 'Barlow Condensed', sans-serif; font-weight: 700; letter-spacing: 4px; }

      /* botões angulares e “reais” */
      .btn, .mens-btn, .segmented-opt, .paid-pill, .reorder-btn {
        border-radius: 0; clip-path: polygon(var(--cut) 0, 100% 0, calc(100% - var(--cut)) 100%, 0 100%);
        font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-style: italic;
        text-transform: uppercase; letter-spacing: 1px; font-size: 16px;
      }
      .btn { border: none; padding: 14px 26px; }
      .btn-primary {
        background: linear-gradient(180deg, #f6d374 0%, var(--gold) 45%, #c8962a 100%); color: #2a1a02;
        box-shadow: inset 0 -4px 0 #7a560f, inset 0 1px 0 rgba(255,255,255,.5);
      }
      .btn-ghost {
        background: linear-gradient(180deg, #3a3d43, #2a2c30); color: #fff;
        box-shadow: inset 0 -4px 0 #131416, inset 0 1px 0 rgba(255,255,255,.12);
      }
      .btn-danger {
        background: linear-gradient(180deg, #c63a5a 0%, #8a1430 60%, #6b0f26 100%); color: #fff;
        box-shadow: inset 0 -4px 0 #3d0715, inset 0 1px 0 rgba(255,255,255,.25);
      }
      .btn:active { transform: translateY(2px); }
      .btn-primary:active { box-shadow: inset 0 -1px 0 #7a560f; }
      .mens-btn { font-size: 13px; padding: 8px 16px; border: none; }
      .mens-btn-gold { --btn-c: var(--gold); }
      .mens-btn-green { --btn-c: var(--gold); }
      .mens-btn-danger { --btn-c: var(--maroon-light); }
      .mens-btn {
        color: #fff;
        background: linear-gradient(180deg, color-mix(in srgb, var(--btn-c) 70%, #fff 0%) 0%, color-mix(in srgb, var(--btn-c) 55%, #000) 100%);
        box-shadow: inset 0 -3px 0 color-mix(in srgb, var(--btn-c) 40%, #000), inset 0 1px 0 rgba(255,255,255,.3);
      }
      .mens-btn-gold, .mens-btn-green { color: #2a1a02; }
      .segmented-opt { border: none; background: var(--surface); box-shadow: inset 0 -3px 0 #131416; color: var(--text-dim); }
      .segmented-opt-on { background: linear-gradient(180deg,#f6d374,#c8962a); color: #2a1a02; box-shadow: inset 0 -3px 0 #7a560f; }

      /* ALERTAS = laranja + preto */
      .send-alert-btn, .mens-btn.send-alert-btn {
        --btn-c: var(--alert); color: #000;
        background: linear-gradient(180deg, #ff9a3d, var(--alert)); box-shadow: inset 0 -3px 0 var(--alert-dark);
      }
      .paid-pill-pending {
        background: var(--alert); color: #000; border: none; box-shadow: inset 0 -3px 0 var(--alert-dark);
      }
      .paid-pill-paid { background: linear-gradient(180deg,#f6d374,#c8962a); color: #2a1a02; border: none; box-shadow: inset 0 -3px 0 #7a560f; }
      .paid-pill { font-size: 13px; padding: 5px 14px; }
      .mensalidade-cta-btn:not(.is-reported) {
        background: var(--alert) repeating-linear-gradient(135deg, transparent 0 12px, rgba(0,0,0,.07) 12px 24px);
        border: none; border-left: 6px solid #000; border-radius: 0;
        clip-path: polygon(var(--cut) 0, 100% 0, calc(100% - var(--cut)) 100%, 0 100%);
        box-shadow: inset 0 -4px 0 var(--alert-dark);
      }
      .mensalidade-cta-btn:not(.is-reported) .mensalidade-cta-title { color: #000; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-size: 20px; text-transform: uppercase; }
      .mensalidade-cta-btn:not(.is-reported) .mensalidade-cta-sub { color: #000; font-weight: 600; }
      .mensalidade-cta-btn.is-reported { border-radius: 0; border-left: 6px solid var(--gold); }
      .payment-alert-modal { border: 2px solid var(--gold); border-radius: 4px; }
      .payment-alert-title { color: var(--gold); }
      .payment-alert-amount { color: var(--gold); }
      .payment-alert-orange { border: 2px solid var(--alert); border-top: 14px solid transparent;
        border-image: repeating-linear-gradient(135deg,#000 0 12px,var(--alert) 12px 24px) 14 / 14px 2px 2px 2px stretch; }
      .payment-alert-orange .payment-alert-title, .payment-alert-orange .payment-alert-amount, .payment-alert-orange .payment-alert-note { color: var(--alert); }

      /* banners */
      .presence-open-banner {
        border-radius: 0; background: #fff; border-left: 8px solid var(--maroon);
        clip-path: polygon(var(--cut) 0, 100% 0, calc(100% - var(--cut)) 100%, 0 100%);
        box-shadow: inset 0 -5px 0 rgba(0,0,0,.2);
      }
      .presence-open-banner-title { color: #1c1d20; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 28px; text-transform: uppercase; }
      .presence-open-banner-cta { color: var(--maroon); font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 16px; text-transform: uppercase; letter-spacing: 1.5px; }
      .escalacao-banner { background: linear-gradient(135deg, var(--maroon-light), var(--maroon)); border-left-color: var(--gold); }
      .escalacao-banner .presence-open-banner-title, .escalacao-banner .presence-open-banner-cta { color: #fff; }
      .extra-banner { background: linear-gradient(135deg, #fff, #e4e6ea); border-left-color: var(--gold); }
      .extra-banner .presence-open-banner-title { color: #1c1d20; }
      .extra-banner .presence-open-banner-cta { color: var(--maroon); }
      .escalacao-banner-concluded { background: linear-gradient(135deg, #4a4d54, #35373c); border-left-color: var(--border); }

      /* cartões / listas */
      .roster-row, .presence-list, .member-search-box, .count-pill, .payment-alert-card, .pix-active-card, .config-block .input, .input {
        border-radius: 4px;
      }
      .roster-row { border-left: 6px solid var(--gold); background: var(--surface); box-shadow: inset 0 1px 0 rgba(233,185,73,.22); }
      .roster-row:hover { border-color: var(--border); border-left-color: var(--gold); }
      .rating-badge-num { font-size: 24px; background: linear-gradient(160deg,#fff1b8,#e0ae3a 45%,#a8731a); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .membership-badge { border-radius: 0; clip-path: polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%); text-transform: uppercase; font-family:'Barlow Condensed',sans-serif; font-style: italic; letter-spacing: .8px; font-size: 12px; padding: 2px 12px; }
      .membership-badge-avulso { background: rgba(255,255,255,.12); color: #fff; border: none; }
      .membership-badge-mensalista { background: rgba(233,185,73,.2); color: var(--gold); border: none; }
      .presence-row { background: var(--surface); border-left: 6px solid var(--gold); padding: 8px 12px; margin-bottom: 6px; border-bottom: none; border-radius: 0;
        clip-path: polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%); box-shadow: inset 0 1px 0 rgba(233,185,73,.2); }
      .presence-name { font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 19px; text-transform: uppercase; letter-spacing: .6px; }
      .presence-avulso-tag { color: #fff; font-family: 'Barlow Condensed',sans-serif; font-style: italic; }
      .presence-by-tag { color: var(--text-dim); }
      .member-search-box { background: var(--surface); }
      .story-ring-unseen { background: conic-gradient(var(--gold), #fff, var(--gold)); }
      .admin-menu-trigger { border-radius: 0; clip-path: polygon(var(--cut) 0,100% 0,calc(100% - var(--cut)) 100%,0 100%); border: none; border-left: 6px solid var(--gold); background: var(--surface); font-family:'Barlow Condensed',sans-serif; font-style: italic; text-transform: uppercase; font-size: 17px; letter-spacing: 1px; }
      .count-pill { background: linear-gradient(90deg,#f6d374,#c8962a); color: #2a1a02; border: none; font-weight: 800; }
      .presence-auto-tag { background: var(--alert) !important; color: #000 !important; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; border: none !important; border-radius: 0 !important; }
      /* ===== LISTA DE PRESENÇA (barras angulares) ===== */
      .presence-card-list { background: transparent; border: none; border-radius: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .presence-card-row {
        padding: 8px 18px 8px 12px; border-bottom: none; background: var(--surface); border-left: 6px solid var(--gold);
        clip-path: polygon(var(--cut) 0, 100% 0, calc(100% - var(--cut)) 100%, 0 100%);
        box-shadow: inset 0 1px 0 rgba(233,185,73,.22);
      }
      .presence-card-row:last-child { border-bottom: none; }
      .presence-card-num { background: transparent; border: none; color: var(--gold); font-family: 'Anton',sans-serif; font-size: 15px; }
      .presence-card-name { font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 20px; letter-spacing: .6px; }
      .presence-card-sub { font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 13px; letter-spacing: 1px; text-transform: uppercase; color: #fff; }
      .presence-card-status { border-radius: 0; clip-path: polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%); font-family:'Barlow Condensed',sans-serif; font-style: italic; text-transform: uppercase; font-size: 14px; letter-spacing: 1px; padding: 6px 14px; }
      .presence-card-status-green { background: var(--gold-soft); color: var(--gold); }
      .presence-card-status-red { background: var(--maroon-soft); color: var(--maroon-light); }
      .presence-card-admin-row { margin-left: 32px; border-top: none; padding-top: 6px; }
      .presence-auto-tag { margin-left: 6px; }
      .presence-group-title {
        display: block; width: fit-content; margin: 20px 0 10px; padding: 3px 22px 3px 12px;
        font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 19px; letter-spacing: 2px; text-transform: uppercase;
        color: #2a1a02; background: linear-gradient(90deg,#f6d374,#c8962a);
        clip-path: polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);
      }
      .presence-page-card { border-radius: 4px; border: none; border-left: 6px solid var(--gold); }
      .presence-page-stats { border-radius: 0; background: var(--surface); border: none; border-left: 6px solid var(--gold); clip-path: polygon(var(--cut) 0, 100% 0, calc(100% - var(--cut)) 100%, 0 100%); }
      .presence-stat-num { font-family: 'Anton',sans-serif; font-weight: 400; font-size: 20px; }
      .presence-stat-label { font-family: 'Barlow Condensed',sans-serif; font-weight: 700; font-size: 11px; letter-spacing: 1.5px; }
      .presence-stat-red .presence-stat-icon, .presence-stat-red .presence-stat-num { color: var(--maroon-light); }
      .presence-my-actions .btn:first-child { border-radius: 0; font-size: 20px; }
      .presence-page-date-btn, .presence-page-menu-btn { border-radius: 0; }
      .presence-section, .presence-share-btn { border-radius: 0; }
      .presence-section { border: none; border-left: 6px solid var(--gold); background: var(--surface); box-shadow: inset 0 1px 0 rgba(233,185,73,.2); }

      /* ===== ELENCO: cartas em escudo ===== */
      .roster-list { gap: 8px; }
      .roster-row {
        border-radius: 0; border: none; border-left: 6px solid var(--gold); background: var(--surface); padding: 8px 18px 8px 8px;
        clip-path: polygon(var(--cut) 0, 100% 0, calc(100% - var(--cut)) 100%, 0 100%);
        box-shadow: inset 0 1px 0 rgba(233,185,73,.22);
      }
      .roster-row-main { gap: 12px; }
      .roster-row .rating-badge {
        order: -1; width: 46px; height: 60px; padding: 0; justify-content: center;
        clip-path: polygon(50% 0,100% 8%,100% 86%,50% 100%,0 86%,0 8%);
        background: linear-gradient(160deg,#fff1b8 0%,#e0ae3a 40%,#a8731a 72%,#6b430a 100%);
      }
      .roster-row .rating-badge-num { -webkit-text-fill-color: #2a1a02; background: none; color: #2a1a02; font-size: 22px; }
      .roster-row .rating-badge-label { color: #2a1a02; font-weight: 800; margin-top: 2px; }
      .roster-name { font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 21px; text-transform: uppercase; letter-spacing: .6px; }
      .roster-sub { font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }
      .roster-row-footer { border-top: none; }
      .avatar-square { border-radius: 0; clip-path: polygon(10% 0,100% 0,90% 100%,0 100%); }
      .avatar-photo, .avatar-fallback { border-radius: inherit; }
      .avatar.avatar-round, .avatar-round.avatar-photo, .avatar-round.avatar-fallback { border-radius: 50% !important; clip-path: none !important; }
      /* perfil (clicar no card): foto cheia até as bordas, em degradê e com carrossel, como na versão original */
      .modal.profile-modal { padding: 0 !important; overflow: hidden; overflow-y: auto; max-width: 440px; }
      .profile-hero { border-radius: 0; height: 400px; }
      .profile-hero-scrim { background: linear-gradient(180deg, rgba(10,9,8,0) 30%, rgba(10,9,8,.35) 55%, rgba(10,9,8,.78) 80%, rgba(10,9,8,.96) 100%); }
      .profile-hero-name-row .avatar { border-radius: 50% !important; }
      .profile-hero-name-text { font-family: 'Anton','Barlow Condensed',sans-serif; text-transform: uppercase; }
      .modal.profile-modal { border: 0 !important; box-shadow: 0 18px 40px rgba(0,0,0,.6) !important; background: #000 !important; border-radius: 18px !important; }
      .profile-hero { border-radius: 18px 18px 0 0; background: #000; }
      .profile-hero-scrim { background: linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.4) 55%, rgba(0,0,0,.82) 80%, #000 100%); }
      .profile-panel { background: #000; }
      .nota-card { width: 84px !important; flex: none; margin: 0 auto 6px; filter: drop-shadow(0 4px 6px rgba(0,0,0,.5)); }
      .nota-n { position: absolute; left: 0; right: 0; top: 17cqw; text-align: center; font-family: 'Anton',sans-serif; font-size: 44cqw; line-height: 1; }
      .nota-p { position: absolute; left: 0; right: 0; top: 66cqw; text-align: center; font-family: 'Barlow Condensed',sans-serif; font-weight: 700; font-size: 15cqw; letter-spacing: 1.5cqw; }
      .profile-stat-nota { display: flex; flex-direction: column; align-items: center; }
      /* grupos da lista: goleiros bordô, confirmados dourado, avulsos prata, ausentes cinza escuro */

      /* ===== transições: cortina diagonal (padrão) e túnel de velocidade (lista/escalação) ===== */
      @keyframes fx-curtain-in { from { clip-path: polygon(0 0,0 0,-30% 100%,-30% 100%); } to { clip-path: polygon(0 0,140% 0,110% 100%,-30% 100%); } }
      @keyframes fx-curtain-out { from { clip-path: polygon(0 0,140% 0,110% 100%,-30% 100%); } to { clip-path: polygon(0 0,0 0,-30% 100%,-30% 100%); } }
      @keyframes fx-line-in { from { background-position: 0% 0; opacity: 1; } to { background-position: 100% 0; opacity: 1; } }
      @keyframes fx-line-out { from { background-position: 100% 0; opacity: 1; } to { background-position: 0% 0; opacity: 1; } }
      @keyframes fx-tunnel-in { 0% { transform: scale(.1); opacity: 0; } 100% { transform: none; opacity: 1; } }
      @keyframes fx-tunnel-out { 0% { transform: none; opacity: 1; } 100% { transform: scale(.1); opacity: 0; } }
      @keyframes fx-rays { 0% { opacity: 0; transform: scale(.6); } 35% { opacity: 1; } 100% { opacity: 0; transform: scale(2.4); } }
      .rules-page, .presence-page, .modal-backdrop .modal { animation: fx-curtain-in .55s cubic-bezier(.6,0,.3,1) backwards; }
      .modal-backdrop .modal.profile-modal, .modal-backdrop .modal { animation-name: fx-curtain-in; }
      .rules-page::after, .presence-page::after, .modal-backdrop::after { content: ""; position: fixed; pointer-events: none; z-index: 9999; }
      .rules-page::after, .presence-page::after, .modal-backdrop::after { inset: 0; width: auto; height: auto; overflow: hidden; opacity: 0; background-image: linear-gradient(90deg, transparent, #f6d374 30%, #fff 50%, #f6d374 70%, transparent); background-repeat: no-repeat; background-size: 18px 100%; background-position: 0 0; filter: drop-shadow(0 0 12px #e9b949); animation: fx-line-in .55s cubic-bezier(.6,0,.3,1) backwards; }
      body.fx-leaving .rules-page, body.fx-leaving .presence-page, body.fx-leaving .modal-backdrop .modal { animation: fx-curtain-out .42s cubic-bezier(.6,0,.3,1) both; }
      body.fx-leaving .rules-page::after, body.fx-leaving .presence-page::after, body.fx-leaving .modal-backdrop::after { animation: fx-line-out .42s cubic-bezier(.6,0,.3,1) both; }
      @media (prefers-reduced-motion: reduce) {
        .rules-page, .presence-page, .modal-backdrop .modal, .rules-page::after, .presence-page::after, .modal-backdrop::after { animation: none !important; }
      }
      /* destaques: cada vaga troca de carta sozinha, esmaecendo e surgindo suave */
      .fcards { animation: none; }
      .fut-slot { transition: opacity .9s ease, transform .9s ease, filter .9s ease; animation: fut-appear 1s ease both; }
      .fut-slot.fut-fading { opacity: 0; transform: scale(.94) translateY(6px); filter: blur(2px); }
      @keyframes fut-appear { from { opacity: 0; transform: scale(.94) translateY(6px); } to { opacity: 1; transform: none; } }
      /* elenco: mais espaço entre foto e nome */
      .roster-row-main { gap: 20px !important; }
      .roster-row .avatar { margin-right: 4px; }
      /* LISTA ABERTA e ESCALAÇÃO DEFINIDA: mesmo tamanho e mesmas animações (ao vivo, pulo, brilhos) */
      .presence-open-banner { min-height: 118px; align-items: center; will-change: transform;
        animation: pg-gold 1.8s ease-in-out infinite, pg-bounce 2.4s ease-in-out infinite; }
      .escalacao-banner:not(.escalacao-banner-concluded) { animation: pg-gold 1.8s ease-in-out infinite, pg-bounce 2.4s ease-in-out infinite !important; }
      @keyframes pg-bounce { 0%,100% { transform: skewX(-14deg) translate3d(0,0,0); } 50% { transform: skewX(-14deg) translate3d(0,-4px,0); } }
      .presence-open-banner::after { left: -60%; animation: banner-sheen 3.2s ease-in-out infinite; background: linear-gradient(100deg, transparent, rgba(246,211,116,.55), transparent); }
      .escalacao-banner:not(.escalacao-banner-concluded)::after { background: linear-gradient(100deg, transparent, rgba(255,255,255,.65), transparent); }
      @keyframes banner-sheen { 0% { left: -60%; } 55%, 100% { left: 140%; } }
      .presence-open-banner .pob-in, .presence-open-banner .pob-left { backface-visibility: hidden; }
      .escalacao-banner:not(.escalacao-banner-concluded) .pob-live { background: linear-gradient(100deg,#8a1430 0%,#8a1430 38%,#fff 50%,#8a1430 62%,#8a1430 100%); background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
      .presence-open-banner.escalacao-banner-concluded { animation: none !important; }
      .presence-open-banner.escalacao-banner-concluded::after { animation: none; }
      /* ESCALAÇÃO DEFINIDA: fundo dourado, aba bordô, texto preto */
      .escalacao-banner:not(.escalacao-banner-concluded) { background: linear-gradient(100deg,#f6d374,#c8962a) !important; border-left: 8px solid #8a1430 !important; animation: pg-gold 1.8s ease-in-out infinite !important; }
      .escalacao-banner:not(.escalacao-banner-concluded) .presence-open-banner-title, .escalacao-banner:not(.escalacao-banner-concluded) .presence-open-banner-cta { color: #000 !important; }
      .escalacao-banner:not(.escalacao-banner-concluded) .pob-arrow { border-left-color: #000; }
      /* botões LISTA ABERTA / ESCALAÇÃO DEFINIDA +15% */
      .presence-open-banner { padding: 23px 20px; margin-top: 16px; }
      .presence-open-banner .presence-open-banner-title { font-size: 30px; }
      .presence-open-banner .presence-open-banner-cta { font-size: 21px; }
      .escalacao-banner .presence-open-banner-title { font-size: 27.5px; }
      .pob-live { font-size: 14px; }
      .pob-arrow { border-top-width: 9px; border-bottom-width: 9px; border-left-width: 15px; }
      /* confirmar / cancelar presença: brilho o tempo todo */
      .presence-my-actions .btn-primary, .presence-my-actions .btn-danger { position: relative; overflow: hidden; }
      .presence-my-actions .btn-primary::after, .presence-my-actions .btn-danger::after {
        content: ""; position: absolute; top: 0; bottom: 0; left: -70%; width: 45%; pointer-events: none;
        background: linear-gradient(100deg, transparent, rgba(255,255,255,.55), transparent); transform: skewX(-20deg);
        animation: btn-shine 2.2s ease-in-out infinite;
      }
      @keyframes btn-shine { 0% { left: -70%; } 55%, 100% { left: 140%; } }
      /* perfil: posição + time do coração à esquerda, card da nota menor à direita */
      .profile-stats-2 { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
      .profile-stats-left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
      .profile-stats-left .profile-stat { align-items: flex-start; text-align: left; }
      .profile-stats-left .profile-fav-team { margin: 0; padding: 0; background: none; border: 0; }
      .nota-card { width: 62px !important; margin: 0 auto 4px; }
      /* elenco: foto redonda à esquerda, nota em mini card no fim da barra */
      .roster-row .rating-badge { order: 2; margin-left: auto; width: 38px; height: 52px; clip-path: url(#futp); background: none; position: relative; }
      .roster-row .rating-badge.rb-gold { background: linear-gradient(160deg,#fff1b8 0%,#e0ae3a 40%,#a8731a 72%,#6b430a 100%); }
      .roster-row .rating-badge.rb-silver { background: linear-gradient(160deg,#ffffff 0%,#dfe2e8 40%,#a9adb6 74%,#7b7f8b 100%); }
      .roster-row .rating-badge.rb-bord { background: linear-gradient(160deg,#e0587a 0%,#a3183a 40%,#8a1430 70%,#4a0816 100%); }
      .roster-row .rating-badge.rb-bord .rating-badge-num, .roster-row .rating-badge.rb-bord .rating-badge-label { -webkit-text-fill-color: #fff4dc; color: #fff4dc; }
      .roster-row .rating-badge.rb-silver .rating-badge-num, .roster-row .rating-badge.rb-silver .rating-badge-label { -webkit-text-fill-color: #15171c; color: #15171c; }
      .roster-row .rating-badge-num { font-size: 18px; line-height: 1; }
      .roster-row .rating-badge-label { font-size: 9px; margin-top: 1px; }
      .roster-row .avatar { display: block !important; width: 56px; height: 56px; flex: none; border: 2px solid rgba(233,185,73,.55); }
      /* PRESENTE em tons de verde */
      .presence-card-status-green { background: linear-gradient(100deg, rgba(46,160,90,.34), rgba(46,160,90,.16)); color: #5fe08a; }
      /* botão LISTA ABERTA: seta em triângulo bordô, um pouco mais grosso, sem tremer */
      .presence-open-banner { padding: 14px 18px; animation: pg-gold 1.8s ease-in-out infinite; will-change: box-shadow; backface-visibility: hidden; -webkit-font-smoothing: antialiased; }
      .escalacao-banner { animation: pg-bord 2s ease-in-out infinite; }
      .escalacao-banner-concluded { animation: none; }
      .pob-arrow { display: inline-block; width: 0; height: 0; margin-left: 10px; vertical-align: -1px; border-top: 8px solid transparent; border-bottom: 8px solid transparent; border-left: 13px solid #8a1430; }
      .escalacao-banner .pob-arrow { border-left-color: var(--gold); }
      .presence-group-gk { background: linear-gradient(90deg,#b8284a,#6b0f26); color: #fff; }
      .presence-group-gk + .presence-card-list, .presence-group-gk + ul.presence-list { border-left-color: #a3183a; box-shadow: inset 0 1px 0 rgba(224,88,122,.3); }
      .presence-group-ok { background: linear-gradient(90deg,#f6d374,#c8962a); color: #2a1a02; }
      .presence-group-ticket { background: linear-gradient(90deg,#f1f3f7,#9a9ea9); color: #15171c; }
      .presence-group-ticket + .presence-card-list, .presence-group-ticket + ul.presence-list { border-left-color: #b6bac4; box-shadow: inset 0 1px 0 rgba(255,255,255,.25); }
      .presence-group-out { background: linear-gradient(90deg,#4f535b,#2c2e33); color: #fff; }
      .presence-group-out + .presence-card-list, .presence-group-out + ul.presence-list { border-left-color: #5a5e66; box-shadow: none; }

      /* ===== MODAIS ===== */
      .modal { border-radius: 4px !important; border: 2px solid var(--gold); background: var(--surface); box-shadow: 0 10px 0 rgba(0,0,0,.5); }
      .modal-title { font-family: 'Anton','Barlow Condensed',sans-serif; text-transform: uppercase; letter-spacing: 1px; }
      .modal-backdrop { background: rgba(8,8,10,.72); }

      /* ===== LAYOUT FIFA/PES (mockup N-Carvão) ===== */
      /* topo: logo grande centralizado, flare dourado, título e temporada */
      .logo-crest { width: 138px; height: 140px; }
      .topbar { gap: 0; padding-bottom: 8px; }
      .topbar-divider { display: none; }
      .topbar-flare { position: relative; width: 90px; height: 8px; margin: 2px 0 4px;
        background: linear-gradient(90deg, transparent, #e9b949 30%, #fff3c4 50%, #e9b949 70%, transparent) center/100% 2px no-repeat; }
      .topbar-flare::after { content: ""; position: absolute; left: 50%; top: 1px; width: 6px; height: 6px; margin-left: -3px; background: #fff3c4; transform: rotate(45deg); box-shadow: 0 0 10px #e9b949; }
      .pelada-root .topbar-caption { font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 30px; line-height: 1; letter-spacing: 3px; color: #fff; }
      .topbar-season { font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 12px; letter-spacing: 5px; color: var(--gold); margin-top: 2px; text-transform: uppercase; }

      /* animações compartilhadas */
      @keyframes pg-floaty { 0%,100% { translate: 0 0; } 50% { translate: 0 -5px; } }
      @keyframes pg-shine { 0% { background-position: 150% 0; } 100% { background-position: -50% 0; } }
      @keyframes pg-dot { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
      @keyframes pg-gold { 0%,100% { box-shadow: 0 4px 0 rgba(0,0,0,.5), 0 0 0 0 rgba(233,185,73,.55); } 60% { box-shadow: 0 4px 0 rgba(0,0,0,.5), 0 0 0 14px rgba(233,185,73,0); } }
      @keyframes pg-bord { 0%,100% { box-shadow: 0 4px 0 #3d0715, 0 0 0 0 rgba(233,185,73,.55); } 60% { box-shadow: 0 4px 0 #3d0715, 0 0 0 12px rgba(233,185,73,0); } }

      /* banners em paralelogramo: LISTA ABERTA (branco) e ESCALAÇÃO DEFINIDA (bordô) */
      .presence-open-banner {
        clip-path: none; transform: skewX(-14deg); border-radius: 0; border: none; border-left: 6px solid var(--maroon);
        flex-direction: row; align-items: stretch; padding: 10px 16px; margin: 14px 0 0; background: #fff;
        box-shadow: 0 4px 0 rgba(0,0,0,.5); position: relative; overflow: hidden;
        animation: pg-gold 1.8s ease-in-out infinite, pg-floaty 2.4s ease-in-out infinite;
        transition: filter .18s ease, box-shadow .18s ease;
      }
      .presence-open-banner::after { content: ""; position: absolute; top: 0; bottom: 0; left: -60%; width: 40%; background: linear-gradient(100deg, transparent, rgba(255,255,255,.45), transparent); transform: skewX(-20deg); transition: left .55s ease; pointer-events: none; }
      .presence-open-banner:hover { filter: brightness(1.08); }
      .presence-open-banner:hover::after { left: 130%; }
      .presence-open-banner:active { filter: brightness(.9); box-shadow: 0 1px 0 rgba(0,0,0,.5); }
      .pob-in { display: flex; align-items: center; width: 100%; transform: skewX(14deg); text-align: left; }
      .pob-left { flex: 1; display: flex; flex-direction: column; align-items: flex-start; }
      .pob-live { display: inline-flex; align-items: center; gap: 6px; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 12px; letter-spacing: 3px;
        background: linear-gradient(100deg,#8a1430 0%,#8a1430 38%,#ff6f8f 50%,#8a1430 62%,#8a1430 100%); background-size: 250% 100%;
        -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent; animation: pg-shine 1.8s linear infinite; }
      .pob-dot { width: 8px; height: 8px; border-radius: 50%; background: #e0243f; box-shadow: 0 0 8px #ff3b5c; animation: pg-dot 1.1s ease-in-out infinite; -webkit-text-fill-color: initial; }
      .presence-open-banner .presence-open-banner-title { font-size: 26px; line-height: 1; letter-spacing: 1px; }
      .presence-open-banner .presence-open-banner-cta { font-size: 18px; letter-spacing: 1px; white-space: nowrap; }
      .escalacao-banner { background: linear-gradient(100deg,#a3183a,#6b0f26); border-left: 8px solid #fff; animation: pg-bord 2s ease-in-out infinite, pg-floaty 2.6s ease-in-out .5s infinite; flex-wrap: wrap; }
      .escalacao-banner .presence-open-banner-title { color: #fff; font-size: 24px; }
      .escalacao-banner .presence-open-banner-cta { color: var(--gold); }
      .escalacao-banner .pob-in { width: 100%; }
      .escalacao-banner-concluded { background: linear-gradient(100deg,#4a4d54,#35373c); border-left-color: #8a8f96; animation: none; }
      .escalacao-banner-concluded .presence-open-banner-cta { color: #fff; }
      .escalacao-banner-concluded-note { transform: skewX(14deg); }
      .extra-banner { background: #fff; border-left-color: var(--gold); }

      /* lista de presença: um box grande por grupo, nomes em linhas */
      .presence-group-title { display: flex; align-items: center; gap: 8px; width: fit-content; margin: 18px 0 8px; padding: 3px 18px 3px 12px; transform: skewX(-14deg); clip-path: none; font-size: 19px; }
      .presence-group-title > * { transform: skewX(14deg); }
      .presence-group-title .pgt-ico { flex: none; }
      .presence-group-out { background: linear-gradient(90deg,#b8284a,#8a1430); color: #fff; }
      .presence-card-list, ul.presence-list {
        gap: 0; padding: 0; margin: 0 0 4px; list-style: none; background: var(--surface); border-left: 6px solid var(--gold);
        border-radius: 0 6px 6px 0; box-shadow: inset 0 1px 0 rgba(233,185,73,.25); overflow: hidden;
      }
      .presence-group-out + .presence-card-list, .presence-group-out + ul.presence-list { border-left-color: var(--maroon-light); }
      .presence-card-row, ul.presence-list .presence-row {
        clip-path: none; border-radius: 0; border-left: none; background: transparent; box-shadow: none; margin: 0;
        border-bottom: 1px solid var(--border); padding: 8px 12px;
        transition: background .18s ease, translate .18s ease;
      }
      .presence-card-row:last-child, ul.presence-list .presence-row:last-child { border-bottom: none; }
      .presence-card-row:hover, ul.presence-list .presence-row:hover { background: rgba(233,185,73,.07); translate: 3px 0; }
      .presence-card-row:active { background: rgba(233,185,73,.14); translate: 1px 1px; }

      /* botões: transições ao passar o dedo/mouse e clicar */
      .btn, .mens-btn, .segmented-opt, .paid-pill, .reorder-btn, .admin-menu-trigger, .roster-row, .story-circle-btn, .admin-gear-btn {
        transition: transform .18s cubic-bezier(.2,.8,.2,1), filter .18s ease, box-shadow .18s ease, translate .18s ease;
      }
      .btn:hover, .mens-btn:hover, .admin-menu-trigger:hover { filter: brightness(1.1); transform: translateY(-2px); }
      .btn:active, .mens-btn:active, .admin-menu-trigger:active { filter: brightness(.88); transform: translateY(3px); transition-duration: .06s; }
      .roster-row:hover { translate: 4px 0; filter: brightness(1.1); }
      .roster-row:active { translate: 2px 2px; filter: brightness(.9); transition-duration: .06s; }
      .story-circle-btn:hover .story-ring { transform: scale(1.08) rotate(8deg); }
      .story-circle-btn:active .story-ring { transform: scale(.94); }
      .story-ring { transition: transform .2s cubic-bezier(.2,.8,.2,1); }
      .send-alert-btn, .mens-btn.send-alert-btn { background: linear-gradient(90deg, #ffffff 0%, #ffd9b0 45%, #ff7a00 100%) !important; color: #000 !important; box-shadow: inset 0 -3px 0 var(--alert-dark) !important; }

      /* ===== ÍCONES DESENHADOS (no lugar de emoji) ===== */
      .emo { width: 1.1em; height: 1.1em; vertical-align: -0.18em; flex: none; display: inline-block; }
      .emo-dot { width: .75em; height: .75em; border-radius: 50%; vertical-align: -0.05em; box-shadow: 0 0 0 1px rgba(255,255,255,.25); }
      .emo-heart { color: #e0607c; }
      .payment-alert-icon, .announcement-icon { color: var(--gold); line-height: 1; }
      .payment-alert-icon .emo, .announcement-icon .emo { width: 1em; height: 1em; }
      .payment-alert-orange .payment-alert-icon { color: var(--alert); }
      .method-icon, .rule-symbol, .admin-menu-item-icon, .admin-menu-trigger-icon, .membership-badge-icon { display: inline-flex; align-items: center; justify-content: center; color: var(--gold); }
      .admin-menu-item-danger .admin-menu-item-icon { color: var(--maroon-light); }
      .btn .emo, .mens-btn .emo { margin-right: 4px; }
      .story-reaction-btn .emo { width: 26px; height: 26px; vertical-align: middle; }
      .story-like-btn .emo { width: 24px; height: 24px; }

      /* ===== FUNDO IGUAL AO DO MOCKUP (carvão + brilho dourado + faixa diagonal) ===== */
      .stadium-bg {
        background:
          radial-gradient(circle at 20% 6%, rgba(233,185,73,.14), transparent 38%),
          linear-gradient(115deg, #1c1d20 0%, #1c1d20 52%, #232427 52%, #232427 64%, #1c1d20 64%) !important;
      }
      .stadium-photo, .stadium-glow, .floating-logo, .stadium-vignette { display: none !important; }

      /* ===== ALERTAS / POP-UPS FLUTUANTES NO CENTRO DA TELA ===== */
      .modal-backdrop { align-items: center !important; padding: 18px !important; }
      .modal { border-radius: 4px !important; max-width: 440px; padding: 22px 20px 22px !important; max-height: 86vh; animation: pg-pop .22s cubic-bezier(.2,.9,.3,1.2); }
      @keyframes pg-pop { from { opacity: 0; transform: scale(.92) translateY(10px); } to { opacity: 1; transform: none; } }
      .toast { bottom: auto !important; top: 50%; left: 50%; transform: translate(-50%, -50%) !important; border-radius: 0; clip-path: polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%); padding: 14px 28px; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 18px; letter-spacing: .6px; text-transform: uppercase; box-shadow: none; }

      /* ===== ELENCO NO FORMATO DO MOCKUP: barras compactas com escudo (nota + posição) ===== */
      .sec-title { display: flex; align-items: center; gap: 10px; margin: 16px 0 8px; }
      .sec-title span { display: inline-flex; align-items: center; gap: 8px; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 19px; letter-spacing: 2px;
        color: #2a1a02; background: linear-gradient(90deg,#f6d374,#c8962a); padding: 3px 18px 3px 12px; clip-path: polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%); text-transform: uppercase; }
      .sec-title:after { content: ""; flex: 1; height: 2px; background: linear-gradient(90deg, var(--gold), transparent); }
      .roster-list { margin-top: 0; gap: 6px; }
      .roster-row { padding: 0 18px 0 10px; min-height: 70px; display: flex; flex-direction: column; justify-content: center; }
      .roster-row-main { gap: 0; }
      .roster-row .roster-fullname, .roster-row .roster-sub, .roster-row .roster-instagram { display: none !important; }
      .roster-row .rating-badge { margin-right: 12px; width: 44px; height: 58px; flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1; }
      .roster-row .rating-badge-num { font-family: 'Anton',sans-serif; font-size: 19px; font-weight: 400; }
      .roster-row .rating-badge-label { font-family: 'Barlow Condensed',sans-serif; font-style: normal; font-weight: 700; font-size: 9px; letter-spacing: 1px; margin-top: 3px; }
      .roster-row .roster-info { gap: 2px; }
      .roster-row .roster-name { font-size: 21px; line-height: 1.05; }
      .roster-row .membership-badge { background: none; padding: 0; clip-path: none; font-size: 12px; letter-spacing: 1px; align-self: flex-start; }
      .roster-row .membership-badge-icon { display: none; }
      .roster-row .membership-badge-avulso { color: #fff; }
      .roster-row .roster-row-footer { position: absolute; right: 24px; top: 6px; }
      .roster-row .roster-edit-link { font-size: 11px; }
      .interest-cta-btn { justify-content: space-between; text-align: left; border-radius: 0; background: var(--surface) !important; box-shadow: none !important; border-left: 6px solid var(--gold) !important; padding: 14px 18px !important; font-size: 19px !important; color: #fff !important; margin-top: 14px; }
      .interest-cta-btn .count-pill { margin-left: auto; }

      /* ===== DESTAQUES: cartas em escudo (mockup) ===== */
      .fcards-wrap { margin: 4px 0 14px; }
      .fcards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; justify-items: center; animation: pg-fade .5s ease; }
      @keyframes pg-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      .fut { position: relative; width: 100%; max-width: 150px; aspect-ratio: 300 / 420; container-type: inline-size; cursor: pointer;
        filter: drop-shadow(0 10px 14px rgba(0,0,0,.55)); transition: translate .2s cubic-bezier(.2,.8,.2,1), filter .2s ease; }
      .fut:hover { translate: 0 -6px; filter: drop-shadow(0 14px 16px rgba(0,0,0,.65)) brightness(1.08); }
      .fut:active { translate: 0 0; filter: drop-shadow(0 6px 10px rgba(0,0,0,.55)) brightness(.92); transition-duration: .06s; }
      .fut-o { position: absolute; inset: 0; clip-path: url(#futp); }
      .fut-i { position: absolute; inset: 2.4cqw; clip-path: url(#futp); overflow: hidden; }
      /* editar meu perfil: barras no padrão LISTA ABERTA (paralelogramo + borda bordô + sombra) */
      .fld { display: flex; align-items: center; background: var(--surface-2); border-left: 6px solid var(--maroon); padding: 0 16px; height: 46px; margin: 10px 8px 0 0; transform: skewX(-14deg); box-shadow: 0 4px 0 rgba(0,0,0,.5); cursor: text; }
      .fld > * { transform: skewX(14deg); }
      .fld.fld-new { background: linear-gradient(90deg,#3a2c0a,var(--surface-2)); border-left-color: var(--gold); }
      .fld .k { font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; font-size: 13px; color: var(--gold); width: 96px; flex: none; }
      .fld .v { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; color: var(--text); font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; text-transform: uppercase; font-size: 19px; letter-spacing: .6px; padding: 0; }
      .fld .v::placeholder { color: var(--text-dim); opacity: .6; text-transform: none; font-weight: 700; }
      .fut-preview { display: flex; justify-content: center; margin: 22px 0 14px; }
      .modal-actions .mb-save { clip-path: none; border-radius: 0; transform: skewX(-14deg); background: linear-gradient(180deg,#f6d374,#c8962a) !important; color: #2a1a02 !important; box-shadow: 0 4px 0 #7a560f !important; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; letter-spacing: 1px; font-size: 20px; padding: 10px 28px; }
      .modal-actions .mb-save span { display: inline-block; transform: skewX(14deg); }
      .fut-gold .fut-o { background: linear-gradient(160deg,#8a5d12,#5b3a05 60%,#3d2603); }
      .fut-silver .fut-o { background: linear-gradient(160deg,#6d717c,#454955 60%,#2e3038); }
      .fut-bord .fut-o { background: linear-gradient(160deg,#6b0f26,#3d0715 60%,#260410); }
      .fut-gold .fut-i { background: linear-gradient(160deg,#fff1b8 0%,#e0ae3a 38%,#b8862b 70%,#8a5d12 100%); color: #241503; }
      .fut-silver .fut-i { background: linear-gradient(160deg,#ffffff 0%,#dfe2e8 40%,#a9adb6 74%,#7b7f8b 100%); color: #15171c; }
      .fut-bord .fut-i { background: linear-gradient(160deg,#e0587a 0%,#a3183a 38%,#8a1430 66%,#4a0816 100%); color: #fff4dc; }
      .fut-bg { position: absolute; inset: 3cqw; overflow: hidden; clip-path: url(#futp);
        display: flex; align-items: flex-end; justify-content: center; }
      .fut-bg svg { width: 100%; height: 100%; opacity: .4; }
      .fut-bg img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .fut-tint { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 30%, rgba(255,255,255,.22), transparent 60%); }
      .fut-shade { position: absolute; inset: 0; }
      .fut-gold .fut-shade { background: linear-gradient(155deg, rgba(200,150,42,0) 0%, rgba(200,150,42,0) 42%, rgba(200,150,42,.16) 52%, rgba(200,150,42,.42) 62%, rgba(200,150,42,.74) 74%, rgba(200,150,42,.94) 86%, rgba(200,150,42,1) 94%); }
      .fut-silver .fut-shade { background: linear-gradient(155deg, rgba(154,158,169,0) 0%, rgba(154,158,169,0) 42%, rgba(154,158,169,.16) 52%, rgba(154,158,169,.42) 62%, rgba(154,158,169,.74) 74%, rgba(154,158,169,.94) 86%, rgba(154,158,169,1) 94%); }
      .fut-bord .fut-shade { background: linear-gradient(155deg, rgba(107,15,38,0) 0%, rgba(107,15,38,0) 42%, rgba(107,15,38,.16) 52%, rgba(107,15,38,.42) 62%, rgba(107,15,38,.74) 74%, rgba(107,15,38,.94) 86%, rgba(107,15,38,1) 94%); }
      .fut-bar { position: absolute; left: 24cqw; right: 0; top: 4.5cqw; height: 16cqw; border-radius: 2cqw 0 0 2cqw; box-shadow: 0 1cqw 2cqw rgba(0,0,0,.35); }
      .fut-bar.noshirt { left: 11cqw; }
      .fut-gold .fut-bar { background: linear-gradient(180deg,#33200a,#1a0f02); }
      .fut-silver .fut-bar { background: linear-gradient(180deg,#3a3d46,#22252b); }
      .fut-bord .fut-bar { background: linear-gradient(180deg,#7a1230,#4d0a1e); }
      .fut-cam { position: absolute; left: 15cqw; top: 1cqw; width: 23cqw; height: 23cqw; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 .5cqw .5cqw rgba(0,0,0,.55)) drop-shadow(0 1.8cqw 2cqw rgba(0,0,0,.7)); }
      .fut-cam svg { position: absolute; inset: 0; width: 100%; height: 100%; }
      .fut-gold .fut-cam svg { fill: #241503; }
      .fut-silver .fut-cam svg { fill: #2a2d34; }
      .fut-bord .fut-cam svg { fill: #5d0e24; }
      .cam-n { position: relative; margin-top: 2.4cqw; font-family: 'Anton',sans-serif; font-size: 8.5cqw; line-height: 1; letter-spacing: .1cqw; }
      .fut-gold .cam-n, .fut-bord .cam-n, .fut-gold .fut-name, .fut-gold .fut-tag, .fut-bord .fut-name, .fut-bord .fut-tag { color: #f6d374; }
      .fut-silver .cam-n, .fut-silver .fut-name, .fut-silver .fut-tag { color: #fff; }
      .fut-name { position: absolute; left: 38cqw; right: 8cqw; top: 6.5cqw; text-align: center; font-family: 'Barlow Condensed',sans-serif; font-weight: 700; font-size: 9cqw; letter-spacing: .5cqw; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1; }
      .fut-tag { position: absolute; left: 38cqw; right: 8cqw; top: 15.7cqw; text-align: center; font-family: 'Oswald',sans-serif; font-weight: 500; font-size: 3.7cqw; letter-spacing: 1.3cqw; text-transform: uppercase; line-height: 1; opacity: .92; }
      .fut-name.noshirt, .fut-tag.noshirt { left: 14cqw; }
      .fut-rate { position: absolute; right: 18cqw; top: 86cqw; height: 36cqw; display: flex; flex-direction: column; justify-content: center; align-items: center; line-height: 1; }
      .fut-rate b { font-family: 'Anton',sans-serif; font-weight: 400; font-size: 26cqw; line-height: .95; }
      .fut-rate i { font-family: 'Barlow Condensed',sans-serif; font-style: normal; font-weight: 700; font-size: 8cqw; letter-spacing: 1cqw; margin-top: 1.5cqw; }
      .fut-av { position: absolute; left: 9cqw; top: 86cqw; width: 36cqw; height: 36cqw; border-radius: 50%; overflow: hidden; background: rgba(0,0,0,.32);
        border: .9cqw solid rgba(0,0,0,.45); box-shadow: 0 0 0 .7cqw rgba(255,255,255,.35); display: flex; align-items: center; justify-content: center; color: #fff; }
      .fut-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .fut-av-ini { font-family: 'Anton',sans-serif; font-size: 14cqw; }
      .fut-glass { position: absolute; inset: 0; pointer-events: none; opacity: .55; mix-blend-mode: soft-light;
        background: linear-gradient(118deg, rgba(255,255,255,.55) 0%, rgba(255,255,255,.22) 24%, rgba(255,255,255,0) 25%, rgba(255,255,255,0) 58%, rgba(255,255,255,.16) 59%, rgba(255,255,255,0) 78%); }
      .fut-glass2 { position: absolute; left: 0; right: 0; top: 0; height: 22%; pointer-events: none; background: linear-gradient(180deg, rgba(255,255,255,.38), rgba(255,255,255,0)); }
      .fcards-dots { display: flex; gap: 6px; justify-content: center; margin-top: 10px; }
      .fcards-dots button { width: 8px; height: 4px; border: none; padding: 0; background: var(--border); cursor: pointer; transition: width .25s ease, background .25s ease; }
      .fcards-dots button.on { width: 18px; background: var(--gold); }
    
      /* botões LISTA ABERTA / ESCALAÇÃO DEFINIDA: 15% menores */
      .presence-open-banner { min-height: 100px; padding: 20px 17px; margin-top: 14px; }
      .presence-open-banner .presence-open-banner-title { font-size: 25.5px; }
      .presence-open-banner .presence-open-banner-cta { font-size: 18px; }
      .escalacao-banner .presence-open-banner-title { font-size: 23.4px; }
      .pob-live { font-size: 12px; }
      .pob-arrow { border-top-width: 8px; border-bottom-width: 8px; border-left-width: 13px; margin-left: 8px; }

      .rules-page { max-width: 100%; overflow-x: clip; }

      /* ===== CRONÔMETRO: placar eletrônico ===== */
      .sb-modal { max-width: 440px; }
      .sb-board { position: relative; overflow: hidden; background: #131417; border: 3px solid #2c2e33; border-radius: 6px; padding: 16px 12px 12px;
        box-shadow: inset 0 0 40px rgba(0,0,0,.8), inset 0 0 0 2px #0a0a0b, 0 6px 0 rgba(0,0,0,.5);
        background-image: radial-gradient(rgba(255,255,255,.035) 1px, transparent 1.4px); background-size: 6px 6px; }
      .sb-lamps { display: flex; justify-content: space-between; padding: 0 4px 10px; }
      .sb-lamps i { width: 7px; height: 7px; border-radius: 50%; background: #3a3000; box-shadow: inset 0 0 2px #000; }
      .sb-digits { display: flex; align-items: center; justify-content: center; gap: 2.5%; }
      .sb-digit { width: 19%; height: auto; overflow: visible; }
      .sb-seg { fill: #2a2400; opacity: .9; }
      .sb-seg.sb-on { fill: #ffe44d; opacity: 1; filter: drop-shadow(0 0 3px #ffd400) drop-shadow(0 0 9px rgba(255,196,0,.95)); }
      .sb-colon { display: flex; flex-direction: column; justify-content: center; gap: 22px; padding: 0 1%; }
      .sb-colon i { width: 11px; height: 11px; background: #ffe44d; border-radius: 2px; box-shadow: 0 0 4px #ffd400, 0 0 12px rgba(255,196,0,.95); }
      .sb-colon-run i { animation: sb-colon 1s steps(1) infinite; }
      @keyframes sb-colon { 50% { opacity: .15; } }
      .sb-caption { text-align: center; margin-top: 10px; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; letter-spacing: 6px; font-size: 14px; color: #ffe44d; text-shadow: 0 0 8px rgba(255,196,0,.8); }
      .sb-flash { position: absolute; inset: 0; z-index: 3; pointer-events: none; background: radial-gradient(circle at 50% 45%, rgba(255,228,77,.55), rgba(255,140,0,.25) 60%, transparent 85%); animation: sb-flash 1s ease-out forwards; }
      @keyframes sb-flash { 0% { opacity: 1; } 100% { opacity: 0; } }
      .sb-warn { animation: sb-pulse 1s ease-out infinite; }
      @keyframes sb-pulse { 0% { box-shadow: inset 0 0 40px rgba(0,0,0,.8), 0 0 0 0 rgba(255,214,0,.9), 0 6px 0 rgba(0,0,0,.5); } 100% { box-shadow: inset 0 0 40px rgba(0,0,0,.8), 0 0 0 18px rgba(255,214,0,0), 0 6px 0 rgba(0,0,0,.5); } }
      .sb-warn .sb-seg.sb-on { filter: drop-shadow(0 0 4px #ffb300) drop-shadow(0 0 14px rgba(255,160,0,1)); }
      .sb-done { animation: sb-alarm .7s steps(1) infinite; }
      @keyframes sb-alarm { 0%, 100% { background-color: #131417; } 50% { background-color: #3a0f0f; } }
      .sb-blink { animation: sb-blink .6s steps(1) infinite; }
      @keyframes sb-blink { 0%, 100% { opacity: 1; filter: brightness(1.6); } 50% { opacity: .08; filter: none; } }
      .sb-adjust { display: flex; gap: 10px; margin-top: 12px; }
      .sb-adjust .btn { flex: 1; font-size: 15px; padding: 10px; }
      .sb-actions { display: flex; gap: 10px; margin-top: 14px; }
      .sb-actions .btn { flex: 1; }
      @media (prefers-reduced-motion: reduce) { .sb-warn, .sb-flash { animation: none; } }

      /* linha entre o logo e "PELADA 4K OFICIAL": brilho e reflexo leves */
      .topbar-flare { width: 150px !important; overflow: visible; animation: flare-glow 3.2s ease-in-out infinite; }
      .topbar-flare::before { content: ""; position: absolute; left: 0; right: 0; top: 3px; height: 2px;
        background: linear-gradient(90deg, transparent 0%, transparent 35%, rgba(255,255,255,.95) 50%, transparent 65%, transparent 100%);
        background-size: 220% 100%; background-position: 160% 0; filter: blur(.4px); animation: flare-sweep 3.2s ease-in-out infinite; }
      .topbar-flare::after { animation: flare-diamond 3.2s ease-in-out infinite; }
      @keyframes flare-sweep { 0% { background-position: 160% 0; } 55%, 100% { background-position: -60% 0; } }
      @keyframes flare-glow { 0%, 100% { filter: drop-shadow(0 0 2px rgba(233,185,73,.5)); } 50% { filter: drop-shadow(0 0 7px rgba(255,236,170,.9)); } }
      @keyframes flare-diamond { 0%, 100% { box-shadow: 0 0 8px #e9b949; } 50% { box-shadow: 0 0 16px 3px #fff3c4; } }
      .topbar-flare-reflex { display: block; width: 110px; height: 6px; margin: -2px auto 4px; opacity: .3; filter: blur(2.5px);
        background: radial-gradient(ellipse at 50% 0%, rgba(233,185,73,.9), transparent 70%); }

      /* ===== CRONÔMETRO compartilhado ===== */
      .sb-by { text-align: center; font-size: 10px; letter-spacing: .6px; color: var(--text-dim); margin-top: 6px; min-height: 14px; text-transform: lowercase; }
      .sb-history { list-style: none; margin: 12px 0 0; padding: 8px 10px; border-left: 2px solid var(--gold-dark); background: rgba(255,255,255,.03); font-size: 11px; color: var(--text-dim); display: flex; flex-direction: column; gap: 3px; }
      .sb-history b { color: var(--text); font-weight: 600; }
      .sw-by { font-family: 'Inter',sans-serif; font-style: normal; font-weight: 500; font-size: 9.5px; letter-spacing: .5px; color: #6b6b6b; text-transform: lowercase; margin-top: 2px; }
      .stopwatch-banner.sw-idle .pob-live { letter-spacing: 2px; }
      .sb-push { margin-top: 12px; }
      .sb-push-btn { width: 100%; background: transparent; color: var(--gold); border: 1px solid var(--gold-dark); padding: 10px 8px; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 13px; letter-spacing: .8px; text-transform: uppercase; cursor: pointer; transform: skewX(-14deg); }
      .sb-push-btn > * , .sb-push-btn svg { transform: none; }
      .sb-push-btn.is-on { color: #5fcf80; border-color: #2f7a48; font-size: 11.5px; }
      .sb-push-note { font-size: 11px; color: var(--text-dim); text-align: center; margin: 0; line-height: 1.4; }

      /* ===== FASE 4: popups modernos (cantos diagonais, degradê, alertas zebrados) ===== */
      .modal-backdrop { background: radial-gradient(90% 60% at 50% 100%, rgba(240,204,60,.07), transparent 70%), rgba(6,5,4,.8) !important; -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
      .modal-backdrop.modal-center { align-items: center; padding: 18px; }
      .modal {
        border: 0 !important; border-left: 6px solid var(--gold) !important; border-radius: 0 !important; box-shadow: none !important;
        background: radial-gradient(120% 70% at 100% 0%, rgba(240,204,60,.11), transparent 55%), linear-gradient(165deg, #2a241b 0%, #17130f 52%, #0e0c09 100%) !important;
        clip-path: polygon(30px 0, 100% 0, 100% calc(100% - 30px), calc(100% - 30px) 100%, 0 100%, 0 30px);
      }
      .modal::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 4px; z-index: 2; pointer-events: none;
        background: linear-gradient(90deg, #fff3b0, var(--gold) 22%, rgba(240,204,60,0) 78%); }
      .modal-title { position: relative; padding-bottom: 10px; margin-bottom: 18px; }
      .modal-title::after { content: ""; display: block; width: 64px; height: 3px; margin-top: 9px; transform: skewX(-32deg); transform-origin: left;
        background: linear-gradient(90deg, var(--gold), rgba(240,204,60,0)); }
      .payment-alert-modal .modal-title::after, .assiduo-modal .modal-title::after { margin-left: auto; margin-right: auto; transform-origin: center; }
      .modal.profile-modal { background: #000 !important; border-left-width: 0 !important; clip-path: polygon(26px 0, 100% 0, 100% calc(100% - 26px), calc(100% - 26px) 100%, 0 100%, 0 26px); }
      .modal.profile-modal::before { display: none; }
      /* alertas: linha zebrada no topo (mesma do botão PAGAMENTO) */
      .payment-alert-modal, .modal.assiduo-modal { border-left: 0 !important; padding-top: 38px; }
      .payment-alert-modal::before, .modal.assiduo-modal::before { height: 16px; opacity: 1;
        background: repeating-linear-gradient(135deg, #000 0 12px, var(--gold) 12px 24px); }
      .payment-alert-orange { border-image: none !important; }
      .payment-alert-orange::before { background: repeating-linear-gradient(135deg, #000 0 12px, var(--alert) 12px 24px) !important; }
      .toast { overflow: hidden; padding-left: 44px !important; }
      .toast::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 22px; background: repeating-linear-gradient(135deg, #000 0 6px, rgba(0,0,0,0) 6px 12px); }
      .sb-modal::before { background: repeating-linear-gradient(135deg, #000 0 12px, var(--gold) 12px 24px); height: 12px; }
      .sb-modal { padding-top: 32px; }
      .sb-hide { margin-top: 10px; font-size: 13px; }

      /* camisa dos destaques: relevo, bainha, gola e sombra projetada */
      .fut-cam { filter: drop-shadow(0 .3cqw .2cqw rgba(0,0,0,.85)) drop-shadow(1.4cqw 2.6cqw 1.8cqw rgba(0,0,0,.8)) drop-shadow(0 0 .7cqw rgba(255,255,255,.22)) !important; }
      .fut-cam .cam-body { stroke: rgba(255,255,255,.42); stroke-width: 1.3; stroke-linejoin: round; }
      .fut-gold .cg1 { stop-color: #7a4f12; } .fut-gold .cg2 { stop-color: #1d1102; }
      .fut-silver .cg1 { stop-color: #727887; } .fut-silver .cg2 { stop-color: #1f2229; }
      .fut-bord .cg1 { stop-color: #b0204a; } .fut-bord .cg2 { stop-color: #420818; }
      .fut-cam .cam-fold { fill: none; stroke: rgba(0,0,0,.5); stroke-width: 1.6; }
      .fut-cam .cam-cuff { fill: none; stroke: rgba(255,255,255,.34); stroke-width: 1.7; stroke-linecap: round; }
      .fut-cam .cam-collar { fill: rgba(0,0,0,.4); stroke: rgba(255,255,255,.6); stroke-width: 2; stroke-linecap: round; }
      .fut-cam .cam-hem { fill: none; stroke: rgba(255,255,255,.3); stroke-width: 1.5; stroke-linecap: round; }
      .fut-seal { position: absolute; right: 3cqw; bottom: 3cqw; z-index: 6; }

      /* presença + selos */
      .profile-attendance { display: flex; align-items: center; gap: 10px; margin: -6px 0 14px; }
      .profile-attendance-text { font-size: 12.5px; letter-spacing: .4px; color: var(--text-dim); }
      .profile-attendance-text b { color: var(--text); font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-size: 16px; }
      .assiduo-seal { background: none; border: 0; padding: 0; cursor: pointer; display: inline-flex; filter: drop-shadow(0 2px 3px rgba(0,0,0,.6)); animation: seal-pop 2.6s ease-in-out infinite; }
      .assiduo-seal svg { width: 100%; height: 100%; }
      @keyframes seal-pop { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
      .assiduo-modal { text-align: center; max-width: 360px; }
      .assiduo-big { display: flex; justify-content: center; margin-bottom: 8px; }

      /* selo de membro: pequeno e discreto, com desenho de cada tipo (ticket / medalha / retorno) */
      .membership-badge { display: inline-flex; align-items: center; gap: 5px; clip-path: none !important; border-radius: 999px !important;
        font-family: 'Inter',sans-serif !important; font-style: normal !important; font-weight: 600; font-size: 10.5px !important; letter-spacing: .3px !important;
        text-transform: none !important; padding: 2px 9px 2px 6px !important; line-height: 1.5; width: fit-content; }
      .membership-badge-mensalista { color: var(--gold) !important; background: rgba(240,204,60,.07) !important; border: 1px solid rgba(240,204,60,.32) !important; }
      .membership-badge-avulso { color: #c9ced8 !important; background: rgba(255,255,255,.05) !important; border: 1px solid rgba(255,255,255,.18) !important; }
      .membership-badge .membership-badge-icon { display: inline-flex !important; font-size: 0; }
      .membership-badge .membership-badge-icon svg { width: 12px; height: 12px; }
      .roster-row .membership-badge { align-self: flex-start; margin-top: 2px; letter-spacing: .3px !important; text-transform: none !important; font-size: 10.5px !important; padding: 2px 9px 2px 6px !important; }
      .roster-row .membership-badge .membership-badge-icon { display: inline-flex !important; }
      .roster-row .membership-badge-avulso { color: #c9ced8 !important; }
      .roster-row .roster-row-footer { right: 78px !important; top: auto !important; bottom: 8px; }
      .membership-badge-profile { margin: -4px 0 10px; }
      .membership-badge-avulso .membership-badge-icon { color: #c9ced8 !important; }

      /* posição de goleiro: GOL + luva, sem estourar o card */
      .pos-gk { display: inline-flex; align-items: center; justify-content: center; gap: .7em; white-space: nowrap; max-width: 100%; }
      .pos-gk .emo { width: 1.15em; height: 1.15em; flex: none; }
      .fut-rate i .pos-gk { gap: 1.2cqw; letter-spacing: .6cqw; }
      .fut-rate i .pos-gk .emo { width: 9cqw; height: 9cqw; }
      .nota-p .pos-gk { gap: 2cqw; letter-spacing: .6cqw; font-size: 13cqw; }
      .nota-p .pos-gk .emo { width: 14cqw; height: 14cqw; }
      .rating-badge-label .pos-gk { gap: 3px; letter-spacing: .4px; }
      .rating-badge-label .pos-gk .emo { width: 11px; height: 11px; }

      /* ajustes: lista aberta/publicada mais escura, stats retangular, sub dourado */
      .presence-page, .escalacao-page { background: #121316 !important; }
      .presence-page-stats { width: calc(100% - 32px); max-width: 640px; margin: 12px auto 0; padding: 0; border-radius: 0; clip-path: none !important; transform: none !important; background: #1a1b1f; border: 1px solid rgba(255,255,255,.08); border-left: 6px solid var(--gold); min-height: 46px; }
      .presence-stat { padding: 6px 4px; gap: 1px; }
      .presence-stat:not(:first-child) { border-left: 1px solid rgba(255,255,255,.08); }
      .presence-stat-num { font-size: 17px; }
      .presence-stat-label { font-size: 9.5px; letter-spacing: 1.2px; }
      .presence-stat-icon { width: 15px; height: 15px; }
      .presence-card-sub { font-weight: 400 !important; color: var(--gold) !important; }
      .presence-card-status { font-size: 11.9px; padding: 5px 12px; }
      .presence-card-status-icon { font-size: 9.4px; }

      .presence-page-card { transform: none !important; }
      .presence-stat-red .presence-stat-icon, .presence-stat-red .presence-stat-num { color: #7d818a !important; }
      .presence-group-out { background: linear-gradient(90deg,#4f535b,#2c2e33) !important; color: #fff; }
      .presence-group-out + .presence-card-list, .presence-group-out + ul.presence-list { border-left-color: #4a4d54 !important; }
      @keyframes pg-spin-slow { to { transform: rotate(360deg); } }
      @keyframes pg-swing { 0%,100% { transform: rotate(-14deg); } 50% { transform: rotate(14deg); } }
      .sec-title .emo { animation: pg-spin-slow 9s linear infinite; transform-origin: 50% 50%; }
      .interest-cta-btn .emo { transform-origin: 50% 8%; animation: pg-swing 2.2s ease-in-out infinite; }

      /* banner do cronômetro: dourado escuro em degradê + faixa pontilhada (igual aos popups) */
      .presence-open-banner .pob-left { padding-left: 12px; }
      .stopwatch-banner { background: linear-gradient(165deg, #c9962a 0%, #7a5614 28%, #2a1d07 62%, #070503 100%) !important; border-left-color: var(--gold) !important; position: relative; }
      .stopwatch-banner::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 9px; pointer-events: none; background: repeating-linear-gradient(135deg, #000 0 9px, var(--gold) 9px 18px); }
      .stopwatch-banner .pob-in { padding-top: 9px; }
      .stopwatch-banner .presence-open-banner-title { color: #fff !important; }
      .stopwatch-banner .presence-open-banner-cta { color: #ffe58a !important; }
      .stopwatch-banner .pob-live { color: #f0cc3c; background: none !important; -webkit-text-fill-color: #f0cc3c; }
      .stopwatch-banner .sw-by { color: rgba(255,255,255,.6); }

      /* TV PELADA 4K */
      .tv-player { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-left: 6px solid var(--gold); overflow: hidden; }
      .tv-player::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 5px; z-index: 2; pointer-events: none; background: repeating-linear-gradient(135deg, #000 0 8px, var(--gold) 8px 16px); }
      .tv-player iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
      .tv-channels { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 18px; }
      .tv-chip { display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border: 0; cursor: pointer; transform: skewX(-14deg); background: #25272b; color: #fff; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 15px; letter-spacing: 1px; text-transform: uppercase; }
      .tv-chip.on { background: linear-gradient(100deg, #f0cc3c, #b8861c); color: #1c1d20; }
      .tv-chip-dot { width: 7px; height: 7px; border-radius: 50%; background: #e0243f; box-shadow: 0 0 6px #ff3b5c; }
      .tv-admin { margin-top: 20px; }
      .tv-admin-box { margin-top: 12px; padding: 14px; background: #1a1b1f; border-left: 6px solid var(--gold); }
      .tv-admin-box .btn-primary { margin-top: 12px; }
      .tv-err { color: #e8656d; }
      .tv-list { list-style: none; margin: 14px 0 0; padding: 0; }
      .tv-list li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid rgba(255,255,255,.08); }

      .tv-picker { position: relative; margin: 12px 0 18px; }
      .tv-select { width: 100%; display: flex; align-items: center; gap: 10px; padding: 13px 16px; border: 0; cursor: pointer; background: linear-gradient(100deg, #f0cc3c, #b8861c); color: #1c1d20; clip-path: polygon(14px 0, 100% 0, calc(100% - 14px) 100%, 0 100%); font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 17px; letter-spacing: 1px; text-transform: uppercase; text-align: left; }
      .tv-select-name { flex: 1; }
      .tv-select-caret { font-size: 16px; transition: transform .2s; }
      .tv-select.open .tv-select-caret { transform: rotate(180deg); }
      .tv-pick-back { position: fixed; inset: 0; z-index: 40; }
      .tv-pick-list { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 41; margin: 0; padding: 0; list-style: none; max-height: 50vh; overflow-y: auto; background: #1a1b1f; border-left: 6px solid var(--gold); box-shadow: 0 12px 28px rgba(0,0,0,.6); }
      .tv-pick-list button { width: 100%; display: flex; align-items: center; gap: 10px; padding: 13px 16px; border: 0; border-top: 1px solid rgba(255,255,255,.07); background: transparent; color: #fff; cursor: pointer; font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 16px; letter-spacing: 1px; text-transform: uppercase; text-align: left; }
      .tv-pick-list li:first-child button { border-top: 0; }
      .tv-pick-list button.on { color: var(--gold); background: rgba(240,204,60,.08); }

      .tv-page { width: 100%; box-sizing: border-box; }
      .tv-page .rules-page-header { width: 100%; box-sizing: border-box; }
      .tv-page .rules-page-body { width: 100%; box-sizing: border-box; }
      .tv-logo { flex: none; width: 46px; height: 28px; display: inline-flex; align-items: center; justify-content: center; background: #fff; border-radius: 3px; overflow: hidden; padding: 2px 4px; box-sizing: border-box; }
      .tv-logo img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
      .tv-logo-ini { background: #000; color: var(--gold); border: 1px solid var(--gold); font-family: 'Barlow Condensed',sans-serif; font-style: italic; font-weight: 800; font-size: 14px; letter-spacing: 1px; }
      .tv-list-name { flex: 1; min-width: 0; }
      .tv-list li { flex-wrap: nowrap; }
      .tv-list li .btn { padding: 6px 10px; font-size: 12px; }
`}</style>
  );
}
