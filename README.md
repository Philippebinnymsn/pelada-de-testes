# Pelada 4K — Sorteio de Times

App web para sortear e equilibrar os times da sua pelada de futebol, com
cadastro de jogadores **compartilhado** (Supabase) — qualquer pessoa que
acessar o link vê o mesmo elenco, e só administradores logados podem
cadastrar, editar ou excluir jogadores.

Você vai usar as três contas que já tem: **Supabase** (banco de dados +
login + fotos), **GitHub** (guarda o código) e **Vercel** (publica o site).

---

## Passo 1 — Configurar o Supabase

1. Entre em **supabase.com** e abra (ou crie) o projeto que vai usar para o Pelada.
2. Vá em **SQL Editor → New query**, cole todo o conteúdo do arquivo
   `supabase/schema.sql` deste projeto, e clique em **Run**.
   Isso cria a tabela `players`, as regras de permissão (qualquer um lê, só
   administrador logado escreve) e o espaço de armazenamento das fotos.
3. Crie sua conta de administrador: **Authentication → Users → Add user →
   Create new user**. Preencha e-mail e senha, e marque **Auto Confirm User**
   (assim não precisa confirmar por e-mail — você já consegue entrar direto
   no app). Essa é a conta que você vai usar para logar como admin dentro do
   Pelada e liberar o cadastro de jogadores.
4. Pegue suas credenciais — o Supabase renomeou as chaves recentemente, então
   use estes nomes:
   - **Project URL**: em **Project Settings → Data API**, seção "Project URL"
     (algo como `https://xxxxxxxxxxxx.supabase.co`)
   - **Publishable key**: em **Project Settings → API Keys → Publishable and
     secret API keys**, é a chave que começa com `sb_publishable_...`
     (é o que era chamado de "anon key" antes — **não** use a `sb_secret_...`,
     essa é só para servidor)

## Passo 2 — Subir o código para o GitHub

1. Crie um repositório novo no GitHub (pode ser privado).
2. Suba todo o conteúdo desta pasta para esse repositório (arrastando os
   arquivos pela interface do GitHub, ou via `git push` se preferir usar o
   terminal). **Não precisa subir a pasta `node_modules` nem o arquivo `.env`**
   (o `.gitignore` já cuida disso).

## Passo 3 — Publicar na Vercel

1. Em **vercel.com → Add New… → Project**, escolha **Import Git Repository**
   e selecione o repositório que você acabou de criar.
2. A Vercel detecta automaticamente que é um projeto Vite — não precisa mudar
   nada nas configurações de build.
3. Antes de clicar em **Deploy**, abra **Environment Variables** e adicione:

   | Nome | Valor |
   |---|---|
   | `VITE_SUPABASE_URL` | a Project URL do Passo 1 |
   | `VITE_SUPABASE_ANON_KEY` | a Publishable key do Passo 1 (`sb_publishable_...`) |

4. Clique em **Deploy**. Em ~1 minuto você recebe um link público
   (ex: `pelada-4k.vercel.app`) já funcionando, com HTTPS.

Pronto — qualquer pessoa que abrir esse link vê o mesmo elenco de jogadores,
vindo do seu Supabase.

### Atualizando o site depois

Qualquer alteração no código: suba pro GitHub (`git push`, ou editando direto
pela interface do GitHub) — a Vercel publica a nova versão sozinha,
automaticamente, a cada push.

---

## 📱 Instalar como app no celular

Depois de publicado, abra o link no celular:
- **iPhone (Safari):** toque em Compartilhar → "Adicionar à Tela de Início"
- **Android (Chrome):** toque no menu (⋮) → "Adicionar à tela inicial" / "Instalar app"

## 🔑 Login individual: administrador x usuário comum

Agora cada jogador pode ter a própria conta (e-mail/senha), além da conta de
administrador. O botão no topo (⚙ / 👤 / 🔓) abre a tela de "Minha conta".

**Usuário comum** (cria a própria conta pelo app, aba "Criar conta"):
- vê a página principal e o elenco, sem precisar de login;
- na lista de presença da próxima pelada, marca **✅ confirmar presença** ou
  **❌ marcar ausência** (clicar de novo no mesmo botão limpa a resposta);
- depois que um admin vincular a conta ao card dele, edita a **própria foto
  de perfil, fotos de capa (carrossel), o nome que aparece** (apelido —
  sempre salvo em caixa alta), **o Instagram e o contato telefônico**. Nome
  completo, nota, posição e goleiro só o admin altera.
- ao criar a conta, ela fica **sem card vinculado** até um administrador
  associar — é assim de propósito, pra evitar que qualquer um se vincule ao
  card de outra pessoa.

**Administrador** (conta criada no Passo 1.3, ou marcada como admin — veja
abaixo):
- cadastra/edita/exclui jogadores do elenco, edita a nota de cada um;
- publica uma nova pelada (abre a lista de presença) e inclui/remove
  qualquer jogador da lista manualmente (confirmado ou ausente);
- inclui **avulsos** — gente de fora do elenco cadastrado, só pra aquela
  pelada específica, sem precisar de conta nem card;
- **vincula o login de um usuário comum ao card dele**: abra o jogador pra
  editar → campo "Login vinculado a este card" → escolha o e-mail que a
  pessoa cadastrou.

### 📷 Instagram e ☎️ contato telefônico

Cada card pode ter um **Instagram** (com o ícone e o `@usuario`, clicável,
abre o perfil numa aba nova) — visível pra todo mundo, e um **contato
telefônico** — visível **só pra administradores**. Os dois são
autoeditáveis: o próprio jogador preenche o dele (aba "Minha conta" →
"Editar minha foto / apelido"); o admin também pode preencher/editar
qualquer um dos dois pelo formulário de edição de jogador.

O telefone não fica na tabela `players` (que é pública/lida por qualquer
um) — fica numa tabela separada (`player_contacts`) com permissão de leitura
travada, no próprio banco, só pra admin ou o dono do card. Não é só a tela
que esconde: mesmo alguém tentando ler direto pela API não consegue ver o
telefone de outra pessoa.

### 🏟️ Como a home se comporta

- **Sem pelada publicada**: a home só mostra os cards do elenco (e, pra
  admin, a barra de ações organizada no topo). Nada de lista vazia poluindo
  a tela.
- **Pelada aberta, antes de segunda 16h**: aparece um botão grande e
  animado, **"LISTA ABERTA · ACESSE AQUI!"** — ao clicar, a lista completa
  (confirmar presença/ausência, Confirmados/Avulsos/M.Ausentes) abre ali
  mesmo na home.
- **A partir de segunda-feira 16h** (horário de Brasília): a lista aparece
  direto na home pra todo mundo, sem precisar clicar em nada.
- **Depois que um admin publica o sorteio**: o sorteio (os times sorteados)
  ocupa o lugar da lista na home. Um botão **"📋 Veja a lista aqui"** abre a
  lista de presença como pop-up, sem precisar sair da tela do sorteio.

### 📋 Lista de presença

A lista aparece na página inicial pra todo mundo, dividida em **✅
Confirmados** (com os goleiros 🥅 em destaque), **🔔 Avulsos (fila de
espera)** e **❌ M. Ausentes**, numerada como no grupo do WhatsApp. Ela
atualiza sozinha na tela de qualquer pessoa que estiver olhando, em tempo
real, à medida que forem confirmando presença ou ausência — não precisa
recarregar a página. Tem também um botão **"Copiar lista para o WhatsApp"**
que gera o texto pronto nesse mesmo formato.

Veja a seção **🏅 Mensalistas x Avulsos** abaixo pra entender a fila de
espera do avulso e como/quando ele sobe pra CONFIRMADOS.

Na hora do sorteio, se já tiver gente confirmada na lista de presença, a
tela "Quem vai jogar?" já abre com elas marcadas (o admin só ajusta se
precisar) — tem também um link **"Puxar lista de presença"** pra reaplicar
isso a qualquer momento.

### 🔓 "Esqueci minha senha"

O app já tem a tela — na aba "Entrar", link **"Esqueci minha senha"** — que
manda um e-mail com um link pra pessoa escolher uma senha nova. Pra esse
e-mail realmente sair, tem duas configurações que só existem no painel do
Supabase (o app sozinho não decide isso):

1. **Site URL e Redirect URLs** — em **Authentication → URL Configuration**:
   - **Site URL**: coloque a URL do seu site publicado (ex:
     `https://pelada-4k.vercel.app`).
   - Em **Redirect URLs**, adicione essa mesma URL (pode adicionar
     `https://pelada-4k.vercel.app/**` pra cobrir qualquer caminho). Sem
     isso, o Supabase recusa o link de recuperação e a pessoa não volta pro
     app depois de clicar no e-mail.
   - Se você testa em `localhost` também, adicione
     `http://localhost:5173/**` na mesma lista.

2. **Envio de e-mail** — o Supabase já vem com um envio de e-mail padrão
   pronto pra testar, mas ele é **bem limitado** (poucas mensagens por hora)
   e não é confiável pra uso real com o grupo todo. Pra funcionar de
   verdade, configure um SMTP próprio em **Project Settings → Authentication
   → SMTP Settings** — dá pra usar um serviço gratuito como
   [Resend](https://resend.com) ou [Brevo](https://www.brevo.com) (têm
   plano free), ou o Gmail via senha de app. Depois de configurar e salvar,
   teste clicando em "Esqueci minha senha" no app.

Sem o SMTP próprio configurado, o link ainda pode funcionar num teste
isolado seu, mas não confie nele pra circular pro grupo inteiro.

### 🔁 Publicação automática (toda semana, sozinha)

A lista roda sozinha, sem ninguém precisar abrir o site:
- **Toda sexta-feira, 12h** — publica a lista de presença pra pelada de
  **segunda-feira seguinte**, sempre na **Arena PSG às 21h**.
- **Toda quarta-feira, 22h** — a lista é encerrada (some da tela inicial;
  nada é apagado do banco, ela vira histórico).

Isso é feito pelo **pg_cron**, uma extensão que roda dentro do próprio
banco do Supabase — funciona mesmo com o site fechado. Já vem configurado
no `schema.sql`; não precisa mexer em nada depois de rodar o arquivo.
Se quiser trocar dia/horário/local, é só editar as funções
`publish_weekly_pelada()` e os horários dos `cron.schedule(...)` no
`schema.sql` e rodar de novo.

> Se o `create extension if not exists pg_cron;` der erro de permissão no
> SQL Editor, ative pela interface: **Database → Extensions**, busque
> "pg_cron" e ative — depois rode o resto do `schema.sql` de novo.

Admin continua podendo publicar/encerrar manualmente a qualquer momento
(botões "publicar outra pelada" / histórico) — a automação é só o padrão.

### 🏅 Mensalistas x Avulsos

Todo jogador cadastrado é **Avulso** por padrão. O administrador é quem
transforma alguém em **Mensalista** — pelo formulário de edição do jogador
(campo "Tipo de membro"), ou aprovando um pedido de interesse (veja abaixo).

- **Mensalista**: aparece no card com o selo **🏅 Membro Mensalista**. Ao
  confirmar presença, entra direto na seção **✅ CONFIRMADOS** da lista.
  Todo dia **1º do mês**, ao abrir o app, recebe um aviso de pagamento da
  mensalidade (R$ 109,20) com os dados de PIX — **exceto os goleiros** (veja
  abaixo).
- **Avulso**: aparece no card como **Membro Avulso**. Ao confirmar presença,
  entra numa **fila de espera** — a seção **🔔 AVULSOS (fila de espera)** da
  lista (junto com os avulsos externos que o admin incluir manualmente) —
  e vê um aviso avisando que ele só entra na lista oficial se sobrar vaga.
- **Fila de espera → lista oficial**: quando um **mensalista (que não seja
  goleiro)** marca **❌ Ausência**, o avulso que está esperando há mais
  tempo sobe automaticamente pra **✅ CONFIRMADOS**, aparecendo com um
  "(avulso)" pequeno ao lado do nome. Isso acontece um avulso por vez, por
  ordem de chegada na fila, e é recalculado sozinho em tempo real conforme
  mensalistas confirmam ou desmarcam ausência — não precisa o admin fazer
  nada manualmente.
- Só quando o avulso **sobe pra CONFIRMADOS** é que ele recebe o aviso de
  pagamento avulso (R$ 30,00) com os dados de PIX — antes disso, enquanto
  está só na fila, não há cobrança. O aviso de pagamento avulso e o de
  mensalidade mostram: chave PIX (Felipe Freitas /
  `duostudiophoto@gmail.com`), valor, botão para copiar a chave, e o pedido
  pra enviar o comprovante a um administrador.
- **Goleiros** são mensalistas mas **não pagam a pelada** — não recebem
  nenhum aviso de cobrança (nem mensalidade nem avulso) e ficam **sempre
  liberados** pra confirmar presença ou marcar ausência, mesmo que o admin
  tenha ligado o bloqueio de mensalista inadimplente. Eles também não
  entram no **💳 Controle de pagamentos** (não tem o que cobrar). Quando um
  goleiro marca ausência, isso **não** libera vaga pra nenhum avulso — só
  mensalistas de linha abrem vaga na fila.
- Um jogador avulso vê o botão **"🏅 Tenho interesse em ser mensalista"**
  (na tela principal e em "Minha conta"). Isso só registra o pedido — quem
  aprova é o admin.
- Pra **membro comum**, a lista de interessados não fica mais fixa na tela:
  agora tem um botão **"🏅 Interesse Mensalista"** (com a contagem de
  pedidos) bem embaixo, depois de todos os cards do elenco — ao clicar,
  a lista abre em **popup** (só pra ver, sem botões de aprovar/recusar).
  Ela atualiza sozinha, em tempo real, conforme as pessoas forem pedindo
  interesse (ou virando mensalista e saindo da lista) — não precisa
  recarregar a página nem reabrir o popup.
- Pra **admin**, essa lista também abre em popup, mas pelo botão da barra
  de ações lá em cima ("🏅 Interessados"), com **Aprovar** e **Recusar**
  em cada linha, e setas **▲ ▼** pra mudar a ordem da fila livremente —
  quem está mais em cima é quem seria promovido primeiro. Quando alguém
  pede interesse, entra sozinho no fim da fila; a posição só muda se um
  admin mexer nas setas.
- Tem também o botão **"🎖️ Mensalistas"**, na mesma barra: mostra todo
  mensalista atual com opção de **tornar avulso** de novo, e um campo
  **"+ tornar alguém mensalista…"** pra promover qualquer jogador na hora,
  sem precisar passar pelo pedido de interesse. O admin controla os dois
  (interessados e mensalistas) livremente, a qualquer momento.
- Essa organização é sempre automática a partir do campo "Tipo de membro":
  o app decide onde cada jogador aparece na lista e o que ele/ela recebe de
  aviso, sem precisar mexer em mais nada quando o admin muda o tipo de
  alguém.

### 💳 Controle de pagamentos (admin)

No botão **"💳 controle de pagamentos"** (perto do histórico), o
administrador tem duas abas:

- **Mensalistas**: lista todo mensalista com um botão **pendente / ✔ pago**
  pra mensalidade do **mês corrente** — cada mês tem seu próprio controle
  (o de setembro não mexe no de outubro). Ali também fica o interruptor
  **"🔒 Bloquear acesso à lista de quem não pagou"**: quando ligado, um
  mensalista com a mensalidade do mês em aberto não consegue confirmar
  presença nem marcar ausência — vê só o aviso de pagamento (com os dados de
  PIX) até o admin marcar como pago. Assim que marca, o acesso libera na
  hora, sem precisar a pessoa recarregar a página.
- **Avulsos da pelada**: lista quem confirmou presença como avulso e **já
  subiu da fila de espera pra CONFIRMADOS** (só quem realmente precisa
  pagar), cada um com o mesmo botão pendente/pago — esse controle é por
  pelada: some/reseta sozinho quando o admin publica a próxima pelada. Esse
  mesmo botão de pago/pendente também aparece direto na lista de presença
  da tela principal, do lado de cada avulso promovido.

### 👤 Admin também confirma a própria presença

Antes só o membro comum via os botões "✅ Confirmar presença" / "❌ Marcar
ausência" pra si mesmo — agora o admin (se tiver card vinculado) também vê
esses botões, exatamente como um jogador comum, além de continuar podendo
marcar/desmarcar a presença de qualquer outro jogador.

Quando é o **admin** quem marca a presença/ausência de outra pessoa (não a
própria pessoa que clicou), o nome de quem fez a marcação aparece bem
pequeno ao lado do nome na lista, tipo "João Silva — Felipe Freitas". Isso
só aparece pra quem está logado como admin — membro comum e visitante veem
a lista normal, sem essa informação.

No campo de incluir alguém manualmente, agora tem dois seletores
separados, iguais em formato: um pra incluir um **mensalista** direto em
CONFIRMADOS (em cima) e outro pra incluir um jogador **avulso já
cadastrado** direto na fila de espera (embaixo, ao lado do campo de nome
pra avulso externo/visitante).

### 💰 Controle financeiro (admin)

No botão **"💰 Financeiro"** da barra de admin, cada administrador tem o
seu próprio **caixa**, separado dos outros:

- **Recebimentos**: preenchido sozinho a partir dos pagamentos que aquele
  admin marcou como pagos — mensalidade (R$ 109,20) e avulso (R$ 30,00),
  de qualquer mês ou pelada, mais recente primeiro. Não precisa lançar nada
  manualmente aqui.
- **Saídas**: o admin escreve a descrição do gasto e o valor e clica
  "Registrar" — só ele mesmo consegue remover uma saída que registrou.
- **Caixa final**: total de recebimentos menos total de saídas daquele
  admin.
- Um seletor **"Ver caixa de"** deixa trocar entre os caixas de qualquer
  administrador (todo mundo pode ver o caixa de todo mundo, mas só
  adiciona/remove saída no próprio).
- Embaixo de tudo, o **"💰 Total geral (todos os caixas)"** soma os
  recebimentos e saídas de **todos** os administradores juntos, sempre
  atualizado.

> Esse recurso precisa do `schema.sql` atualizado (nova tabela
> `cash_expenses` + colunas `paid_by`/`paid_at` em `presences`) — rode de
> novo no SQL Editor do Supabase antes de usar.

### 📢 Aviso (admin)

No botão **"📢 Aviso"** da barra de admin (logo ao lado de "publicar
pelada"), dá pra criar um aviso que aparece como **popup pra todo mundo**
(logado ou não) assim que abrir o app. Ao publicar, você escolhe:

- **Título** (opcional) e **mensagem** (obrigatória).
- **Aparecer só uma vez**: cada pessoa vê o popup uma única vez; depois de
  fechar, não aparece de novo pra ela naquele navegador (mesmo saindo e
  entrando de novo), a não ser que você publique um aviso novo.
- **Aparecer até um prazo**: você escolhe data/hora limite. Até lá, o popup
  volta a aparecer toda vez que a pessoa abrir o app de novo (mesmo já tendo
  fechado antes) — ótimo pra avisos importantes que você quer garantir que
  todo mundo veja várias vezes. Depois do prazo, some sozinho.

O mesmo botão mostra o aviso atualmente publicado (se houver) e permite
**apagá-lo** a qualquer momento, encerrando o popup pra todo mundo na hora
(atualização em tempo real, não precisa recarregar a página). Publicar um
novo aviso substitui o anterior automaticamente.

> Precisa rodar o `supabase/schema.sql` atualizado (cria a tabela
> `announcements`) antes desse botão funcionar.

### 📜 Histórico de presença (admin)

No botão "📜 histórico", ao lado de "publicar pelada", o administrador vê
todas as listas já encerradas (quem confirmou, quem ficou de avulso e quem
marcou ausência em cada pelada passada).

### Tornando alguém administrador

Criar a conta pelo app não torna ninguém admin — isso é proposital. A partir
de agora dá pra fazer isso direto pelo app: na barra de ações do admin,
botão **"👑 Administradores"** — lista todo mundo que já criou conta, com um
botão **"tornar admin"** ao lado de cada um. Clicar já promove na hora; pra
tirar o acesso de alguém, clica no selo **"👑 admin"** da pessoa (só não dá
pra remover o próprio acesso por ali, de propósito, pra ninguém se trancar
fora sem querer — nesse caso outro admin remove).

Continua dando pra fazer por SQL também, se preferir (trocando o e-mail):

```sql
insert into admins (user_id)
select id from auth.users where email = 'seu-email@exemplo.com';
```

Não tem limite de quantos admins podem existir. Quem acabou de ser
promovido precisa recarregar a página (ou sair e entrar de novo) pra ver as
opções de administrador aparecerem.

Essa proteção não é só visual: mesmo que alguém tente burlar pelo navegador,
o próprio banco de dados (via RLS + um gatilho que trava os campos
sensíveis) recusa qualquer gravação fora do que cada tipo de conta pode
fazer.

## 🖼️ Como funcionam as fotos

As fotos (perfil + 3 capas) são enviadas para o **Supabase Storage** assim
que você seleciona o arquivo no cadastro — por isso é preciso estar online e
logado como administrador para adicionar fotos.

## 🛠 Rodando localmente (opcional)

Precisa de Node.js instalado e internet:

```bash
cp .env.example .env      # preencha com as suas credenciais do Supabase
npm install
npm run dev                # ambiente local com hot reload
npm run build               # gera a pasta dist/ pronta para publicar manualmente
```

## 📂 Estrutura do projeto

```
├── supabase/
│   └── schema.sql        ← cole no SQL Editor do Supabase (Passo 1)
├── public/                ← assets estáticos (ícones, manifest, imagens)
├── src/
│   ├── App.jsx              ← todo o app (componentes, algoritmo de sorteio, estilos)
│   ├── main.jsx              ← ponto de entrada
│   └── supabaseClient.js       ← conexão com o Supabase
├── .env.example            ← copie para .env com suas credenciais
├── index.html
└── package.json
```

## ⚠️ Sobre o teto de armazenamento de fotos

O Supabase Storage no plano gratuito tem 1 GB — bem confortável para fotos de
jogadores (cada uma fica na faixa de poucas dezenas de KB, já otimizada pelo
próprio app antes do envio).
