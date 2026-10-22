# Level Sketch

Editor estático de mapas de metroidvania, acessível em `/tools/level-sketch/`.
Não requer build, pacotes, servidor de aplicação ou serviços externos. É servido
diretamente pelo GitHub Pages, junto com o restante do site.

- Mapa de 4096 × 2560 unidades, inicialmente sólido.
- Remover abre áreas jogáveis; preencher reconstrói o terreno.
- Modos Terreno e Decoração com os mesmos pincéis e ações Preencher/Remover.
- Até 32 camadas de decoração: criação, seleção, nomes e visibilidade próprios.
  Na decoração, preencher pinta e remover apaga só a camada selecionada.
  Ações de terreno preservam todas as decorações.
- Botão de olho ou tecla D mostra/oculta todas as decorações. A tecla 3 alterna
  o modo. Camadas ocultas precisam ser mostradas antes de serem editadas.
- Retângulo por arraste com snap, pincel quadrado com snap e redondo suavizado.
- Pan e zoom pelo mouse, atalhos, controles visíveis ou dois dedos.
- IndexedDB salva o mapa, nome, ajustes e posição da câmera no navegador.
- Histórico de desfazer/refazer durante a sessão.
- Backup JSON portátil com comandos editáveis; PNG completo sem grade, com
  as camadas visíveis. O backup mantém todas as camadas, inclusive ocultas.

O formato de documento atual é a versão 2. Mapas locais e backups da versão 1
são convertidos automaticamente, preservando o terreno, as cores e as borrachas
de decoração na primeira camada. O banco IndexedDB e sua chave são mantidos.

Os comandos vetoriais são a fonte do documento. Tiles de 256 px são rasterizados
sob demanda, com cache limitado, para evitar manter o mapa inteiro e cópias de
histórico na memória do celular. O canvas visível limita a densidade a 2×.
A exportação PNG aloca temporariamente um canvas do tamanho total do mapa.

Os dados são locais ao navegador, dispositivo e origem. Limpar os dados do site
remove o salvamento. Backups JSON permitem transferir mapas entre dispositivos.
Não há sincronização entre abas: use uma aba de edição por vez.

Para testar localmente, a partir da raiz do repositório:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Abra `http://127.0.0.1:4173/tools/level-sketch/`.

Testes de interação e persistência, sem instalar dependências:

```powershell
node --test tools/level-sketch/tests/editor.test.cjs
```
