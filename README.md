# KOF · MUGEN AI — v10

Engine de luta client-side que carrega personagens MUGEN (.zip com SFF/AIR/SND/CMD) e coloca duas IAs com aprendizado e predição para lutar entre si.

## Estrutura
```
index.html        ← página (zonas de upload, canvas, hotkeys)
css/style.css     ← estilos
js/core.js        ← constantes, áudio, parsers SFF v1/v2 · AIR · SND, Stage (cenários), MatchLog + exportação de planilha
js/fighter.js     ← classe Fighter (estados, física, golpes, guard, intro/win poses)
js/ai.js          ← IA v10: OppPredictor (Markov ordem-3), ContextBandit (Thompson Sampling), yomi, classe AI
js/game.js        ← partículas, HUD, Game loop, colisões, rounds, teclado, relógio em Web Worker
```

## Deploy (GitHub Pages)
1. Suba a pasta inteira (mantendo `css/` e `js/`) na raiz do repositório.
2. Settings → Pages → branch `main` / root.
3. Acesse a URL e arraste os zips dos personagens.

## Novidades v10
- **Cenário de fundo ("fundo")**: terceira zona de upload aceita **1 imagem** ou um **.zip de imagens**. Várias imagens = o cenário troca a cada round. Também dá para arrastar direto no canvas durante a luta. Desenho em modo *cover* com vinheta para manter lutadores e HUD legíveis.
- **Planilha da luta (tecla X ou botão 📊)**: exporta `.xlsx` (SheetJS) com 5 abas — `Eventos` (cada golpe/bloqueio/whiff/taunt/plano/KO com tick, tempo, dano, HP, barra, plano e previsão das duas IAs), `Rounds` (vencedor, duração, dano, golpes, bloqueios, placar), `Golpes` (precisão acerto/erro por golpe), `IA_Aprendizado` (recompensa média de cada plano por contexto do bandit) e `Resumo`. Fallback CSV se a CDN do xlsx não carregar.
- **Luta continua fora da aba**: o relógio da simulação agora roda num **Web Worker** — browsers limitam `setInterval` da página a 1 tick/s (até 1/min) em abas ocultas, mas timers de Worker não sofrem throttling. Acumulador por relógio de parede garante velocidade real mesmo se houver atraso.
- **Modelos matemáticos mais pesados**:
  - Preditor de gestos virou **Markov de ordem 3** com mistura PPM (pesos 0.50/0.32/0.18 entre contextos de 3, 2 e 1 gestos) — capta padrões mais longos do oponente.
  - Bandit de estratégia virou **Thompson Sampling gaussiano** (posterior Normal com média/variância empíricas) — melhor exploração que UCB1 em ambiente não-estacionário, onde o oponente também aprende.
  - Escolha de golpe agora pondera o **valor esperado condicionado ao gesto previsto**: guarda prevista → golpe baixo; pulo previsto → anti-aéreo; ataque previsto → golpe rápido para trocar; recuo previsto → projétil.
- **Gestos como no jogo**: detecção automática de **intro (anims 190–199 / statedef "intro")** e **pose de vitória (180–189 / "win")**. Round 1 abre com as intros dos dois personagens; o vencedor de cada round faz a pose de vitória durante o K.O. Taunts/showboat seguem da v8/v9.

## Versão automática (auto.html / zip "auto")
Sem nenhuma seleção na tela: ao abrir, o jogo procura **na mesma pasta** do site os arquivos e começa sozinho.
- **Personagens**: todos os `.zip` da pasta — sorteia 2 a cada partida (tecla **N** sorteia outra dupla). Com 1 zip só, luta espelho.
- **Fundo**: qualquer imagem chamada `fundo.*` (png, jpg, webp, gif, bmp...). Se houver várias `fundo*`, cicla a cada round; sem nenhuma `fundo*`, qualquer imagem da pasta serve; **sem imagem nenhuma, fica o escuro padrão**.
- **Como ele descobre os arquivos** (em ordem): API do GitHub (funciona automaticamente em `*.github.io`), índice do servidor (ex.: `python -m http.server`), `manifest.json` na pasta (`["kyo.zip","iori.zip","fundo.png"]`), e por fim tentativa direta de `fundo.*`.
- No zip da versão auto, o `index.html` já É o modo automático.

## v13 — rede neural + SPSA
Análise das planilhas v12: a camada de matchup funcionou (Sinobu×Iori saiu de 0.22 para ~0.50 de winrate; bloqueios de 171 → 6–7 mil), mas dois limites apareceram: (a) a tabela do bandit ficava rala (n≈1–10) porque os contextos discretos fragmentam amostras; (b) em gaps extremos (Terry×Sinobu, powerGap 8.6) nenhum estilo discreto vence e o portfólio empaca. A v13 adiciona:
- **Rede neural (bandit contextual neural)**: MLP 26→20→6 (~660 parâmetros, Float32Array, SGD online com clip) aprende Q(situação, plano) sobre 26 features contínuas — HP, barra, distância, zona, gesto do rival, previsão do Markov, winrate, powerGap, sequência de derrotas. Generaliza entre situações parecidas em vez de fragmentá-las; a Q entra como prior na escolha e o Thompson tabular mantém a exploração. Custo: 1 forward+backward por episódio (~640 multiplicações). Teste: aprende política condicional com RMSE 0.049.
- **SPSA (Simultaneous Perturbation Stochastic Approximation)**: quando nenhum estilo discreto tem recompensa >0.25 após ≥22 blocos, ativa o estilo CUSTOM e otimiza continuamente o vetor de 7 knobs (agressão, paciência, risco, guarda, atraso de engajamento, pulo, projétil) perturbando ±cΔ em blocos alternados de 4 rounds — encontra misturas que não existem no portfólio. Teste sintético: winrate 0.17→0.36 com θ convergindo ao ótimo.
- **Decays recalibrados**: bandit 0.93→0.985 e preditor 0.88→0.94 (a memória estava sendo apagada rápido demais), e o evento ESTILO agora só é registrado quando muda.
- Planilha: a aba Matchup ganha linhas da rede (passos de treino, RMSE) e do θ do SPSA. Rede e SPSA persistem no localStorage.

## v12 — IA aprende a vencer rivais mais fortes
Análise de 4 planilhas reais (180k+ eventos) mostrou: o bandit quase nunca decidia (0–14 eventos PLANO → aba IA vazia), o perdedor ficava estagnado (Zero: ~0% de winrate por 1100 rounds, Terry 1098×8) e quase não havia bloqueio (171 em 34k eventos). A v12 adiciona:
- **MatchupModel**: winrate EWMA + dps próprio×rival (powerGap) classificam o confronto em DOMINANT/EVEN/UNDERDOG/CRUSHED.
- **Busca de portfólio de contra-estilos** (Thompson em blocos de 8 rounds): TURTLE_PUNISH, HIT_AND_RUN, ZONE_KEEPOUT, AIR_ASSAULT, ALL_IN_BURST — cada um reconfigura agressão, paciência, risco, guarda, atraso de engajamento, viés de pulo/projétil. O estilo vencedor é mantido enquanto o confronto não estiver dominado. Teste: 79% de uso do contra-estilo correto após convergir.
- **Defesa reativa**: probabilidade real de bloquear ataques em curso, ampliada quando em desvantagem; rivais especiais assustam mais.
- **Anti-troca**: com powerGap>1.3, não troca dano sem vantagem (punição/previsão) — só poke seguro; e não entra no rush de início de round.
- **Rubber-band legítimo**: derrotas seguidas afiam reação/confirm (cap 0.98/0.95), vitórias relaxam ao talento base.
- **Recompensa escalada**: vencer trocas contra rival mais forte ensina mais o bandit; episódios de plano agora acompanham TODOS os planos (aba IA_Aprendizado volta a sair preenchida) e há nova aba **Matchup** na planilha.

## Correções v11
- **Planilha não exportava**: `game` é declarado com `let` (escopo léxico), então `window.game` era `undefined` e o export abortava com "Inicie uma luta primeiro" — além de WHIFF/TAUNT/PLANO não serem gravados. Corrigido em todos os pontos.
- **Fundo não preenchia a tela**: o canvas mantém 16:9 e sobravam barras pretas. Agora o cenário também é aplicado como background CSS de `#fight-screen` (cover + leve escurecida), cobrindo 100% da tela em qualquer proporção; o canvas continua desenhando o fundo internamente.

## Hotkeys
R reiniciar · T turbo · +/− velocidade · D debug · G log · L mute · **X planilha** · **N nova dupla (modo auto)**

## Resetar aprendizado persistido
```js
Object.keys(localStorage).filter(k=>k.startsWith('kofai9:')).forEach(k=>localStorage.removeItem(k));
```
