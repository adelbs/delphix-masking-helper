/**
 * Copy for the GitHub Pages site, in the three languages the project supports.
 *
 * The landing page is deliberately non-technical: it says what the tool is for and who it
 * helps, and sends anyone who wants jars, ports and build steps to the repository README.
 * The framework pages carry the reference content, generated from docs/src/guide.<locale>.html.
 */

export const REPO = 'https://github.com/adelbs/delphix-masking-helper'
/** Where the site is served from — the installers are fetched from here. */
export const SITE = 'https://adelbs.github.io/delphix-masking-helper'

export const LANG_NAMES = { 'en': 'English', 'pt-BR': 'Português', 'es': 'Español' }
export const LANG_ABBR  = { 'en': 'EN', 'pt-BR': 'PT', 'es': 'ES' }

/** File names on the site. English is the site root; the others sit beside it. */
export const PAGES = {
  'en':    { home: 'index.html',       frameworks: 'frameworks.html',       htmlLang: 'en' },
  'pt-BR': { home: 'index.pt-BR.html', frameworks: 'frameworks.pt-BR.html', htmlLang: 'pt-BR' },
  'es':    { home: 'index.es.html',    frameworks: 'frameworks.es.html',    htmlLang: 'es' },
}

/** Pages the reference used to live at, kept as redirects so shared links keep working. */
export const LEGACY_REDIRECTS = {
  'algorithms.html': 'frameworks.html',
  'algorithms.pt-BR.html': 'frameworks.pt-BR.html',
  'algorithms.es.html': 'frameworks.es.html',
}

export const T = {
  'en': {
    title: 'Delphix Masking Helper',
    tagline: 'Build, test and maintain Delphix masking algorithms — on your own machine.',
    lede: 'Work out which masking framework fits your data, try it against real values, build a ready-to-use configuration and push it straight to your engine — without creating a Rule Set or waiting on a masking job.',
    ctaRepo: 'View on GitHub',
    ctaFrameworks: 'Browse the frameworks',
    demoAlt: 'An algorithm being tested, a classifier tested against a described column, the profile sets that ship with the tool, and a connected Delphix engine',
    demoCaption: 'Four things, in order: running an algorithm against a real value; testing a classifier against a column described on screen, and seeing which domain profiling would assign; the profile sets that ship with the tool; and the integration with a Delphix engine, with an algorithm that came down from it. Every masked value is real output from the plugin.',

    noticeTitle: 'An independent project — and what you need to use it',
    noticeIndependent: '<strong>No affiliation with Delphix.</strong> This is an independent open source project. It is not built, endorsed, reviewed or supported by Delphix or its owners, and nothing here is an official product. Delphix and the product names used on this site are trademarks of their respective owners.',
    noticeLicense: '<strong>An active Delphix licence is required.</strong> The masking frameworks live in Delphix product libraries, which this project does not distribute and cannot replace. To run the tool you must already be entitled to those libraries and able to obtain the Masking Devkit (SDK) from Delphix — normally through an active licence and your account team.',
    ctaInstall: 'Install it',
    installTitle: 'Install it',
    installLede: 'One command. It asks where to put things, checks that Node, Java and git are on your machine — it never installs them, it only tells you what is missing — and leaves you a <code>dlpx-helper</code> command to start and stop the app.',
    installMac: 'macOS and Linux',
    installWin: 'Windows (PowerShell)',
    installCopy: 'Copy',
    installCopied: 'Copied',
    installReadFirst: 'Rather read it before running it? Download the same script, open it, then run it — the page for your system shows both ways.',
    installAfterTitle: 'Then one step only you can do',
    installAfter: 'Copy the jars from your Masking Devkit (SDK) into the <code>lib</code> folder it created. The app opens on a screen listing exactly which files it needs and where they go.',
    installCmds: 'Once installed: <code>dlpx-helper</code> starts it and opens the browser, <code>dlpx-helper stop</code> stops it, <code>dlpx-helper update</code> brings the latest version. Updating never touches your saved algorithms.',
    installManual: 'Full instructions, including the manual steps',
    featuresTitle: 'Everything an algorithm needs, in one place',
    features: [
      { h: 'Understand', p: 'Each of the 31 masking frameworks explained in plain language: what it does, what it expects as input, and what every parameter changes. No more guessing from a parameter name.' },
      { h: 'Test', p: 'Run an algorithm against a real value and see the output immediately. Try a configuration, change one field, run it again — the loop takes seconds instead of a job run.' },
      { h: 'Build', p: 'Describe the problem in your own words and get back a configured algorithm, saved and ready to run. You do not need to know which framework to reach for.' },
      { h: 'Sync', p: 'Connect to a Masking Engine and mirror it here — algorithms, domains, classifiers and profile sets — or push your work up. What came from the engine is updated there, not duplicated beside it.' },
    ],

    syncTitle: 'Connected to your engine',
    syncP: 'Connect a Masking Engine and the whole of it comes down to work on: its algorithms, domains, classifiers and profile sets. Change what you need, run it against real values until it does what it should, and send it back. The engine gets an update, not a second copy — the tool remembers where everything came from, and whatever an object relies on travels with it. Anything you build from scratch goes up as new.',
    syncNote: 'Nothing is sent anywhere until you ask for it.',
    discoveryTitle: 'Find the sensitive data before you mask it',
    discoveryP: 'Masking starts with knowing which columns hold personal data. The tool keeps the domains, classifiers and profile sets a profiling job runs, and tests a classifier against a column you describe — its name, its type, a few sample values — showing how confident the profiler would be and which domain it would assign. Nothing runs on the engine.',
    presetsTitle: 'Ready-made for four data protection laws',
    presetsP: 'Load one and everything it needs is created in one go: the profile set, its classifiers, the domains they find, the algorithms that mask them and the files those read — the essential pack with the minimum for the law, or the extended pack with all of it. National identifiers keep a valid check digit after masking. Every set comes with a PDF documenting each item, and unloading removes what it brought.',
    presetsDoc: 'Documentation (PDF)',
    presets: [
      { country: 'Chile', law: 'Ley 21.719', id: 'chile-ley-21719' },
      { country: 'Mexico', law: 'LFPDPPP (2025)', id: 'mexico-lfpdppp' },
      { country: 'Panama', law: 'Ley 81 de 2019', id: 'panama-ley-81' },
      { country: 'Belize', law: 'Data Protection Act, 2021', id: 'belize-dpa-2021' },
    ],
    assistantTitle: 'An assistant that checks its own work',
    assistantP: 'Describe what you need to mask and the assistant picks the framework and configures it. Before anything is saved it actually runs the algorithm with that configuration — if it does not work, nothing is saved and you are told why. A configuration that looks plausible but fails never reaches you.',
    assistantNote: 'Building takes a hosted model — Claude, Gemini or GitHub Models. The default local model keeps everything on your machine and advises: it explains and recommends, but does not save algorithms.',

    guideTitle: 'The framework reference',
    guideP: 'Every framework documented in full — behaviour, input format, worked input → output examples and every configuration parameter — plus the classifiers behind sensitive data discovery. Each example was produced by actually running the framework, never estimated.',
    guideCta: 'Read it online',
    pdfTitle: 'Or take it with you',
    pdfP: 'The same reference as a printable PDF, one per language.',
    pdfCta: 'Download PDF',


    frameworksTitle: 'Framework reference',
    frameworksLede: 'All 31 masking frameworks in the Delphix plugin. Configure one and you get an algorithm. Every input → output pair on this page came from actually running the framework. Part 10 covers the classifiers the profiler uses to find the sensitive data in the first place.',
    backHome: 'Home',
    onThisPage: 'On this page',
    footerRepo: 'Source and technical documentation on GitHub',
    footerLicense: 'Mozilla Public License 2.0. An independent open source project, not affiliated with or endorsed by Delphix; Delphix product libraries are not distributed with it, and an active Delphix licence is required to use it. Trademarks belong to their respective owners.',
  },

  'pt-BR': {
    title: 'Delphix Masking Helper',
    tagline: 'Construa, teste e mantenha algoritmos de mascaramento do Delphix — na sua própria máquina.',
    lede: 'Descubra qual framework de mascaramento serve para o seu dado, experimente com valores reais, construa uma configuração pronta para usar e publique direto na sua instância — sem criar Rule Set nem depender de um masking job.',
    ctaRepo: 'Ver no GitHub',
    ctaFrameworks: 'Conhecer os frameworks',
    demoAlt: 'Um algoritmo sendo testado, um classifier testado contra uma coluna descrita, os profile sets que vêm com a ferramenta, e uma instância Delphix conectada',
    demoCaption: 'Quatro coisas, nesta ordem: executar um algoritmo com um valor real; testar um classifier contra uma coluna descrita na tela e ver qual domínio o profiling atribuiria; os profile sets que vêm com a ferramenta; e a integração com uma instância Delphix, com um algoritmo que veio dela. Todos os valores mascarados são saída real do plugin.',

    noticeTitle: 'Um projeto independente — e o que você precisa para usar',
    noticeIndependent: '<strong>Sem qualquer relação com a Delphix.</strong> Este é um projeto open source independente. Não é feito, endossado, revisado nem suportado pela Delphix ou por seus detentores, e nada aqui é produto oficial. Delphix e os nomes de produto citados neste site são marcas de seus respectivos donos.',
    noticeLicense: '<strong>É necessária uma licença Delphix ativa.</strong> Os frameworks de mascaramento vivem em bibliotecas do produto Delphix, que este projeto não distribui e não substitui. Para rodar a ferramenta você já precisa ter direito a essas bibliotecas e conseguir o Masking Devkit (SDK) com a Delphix — normalmente por meio de uma licença ativa e do seu time de conta.',
    ctaInstall: 'Instalar',
    installTitle: 'Instalar',
    installLede: 'Um comando. Ele pergunta onde colocar as coisas, confere se Node, Java e git estão na sua máquina — nunca os instala, apenas avisa o que falta — e deixa um comando <code>dlpx-helper</code> para subir e derrubar o app.',
    installMac: 'macOS e Linux',
    installWin: 'Windows (PowerShell)',
    installCopy: 'Copiar',
    installCopied: 'Copiado',
    installReadFirst: 'Prefere ler antes de executar? Baixe o mesmo script, abra e depois rode — a página do seu sistema mostra as duas formas.',
    installAfterTitle: 'Depois, um passo que só você pode dar',
    installAfter: 'Copie os jars do seu Masking Devkit (SDK) para a pasta <code>lib</code> que ele criou. O app abre numa tela listando exatamente quais arquivos faltam e onde vão.',
    installCmds: 'Depois de instalado: <code>dlpx-helper</code> sobe e abre o navegador, <code>dlpx-helper stop</code> derruba, <code>dlpx-helper update</code> traz a versão mais nova. Atualizar nunca mexe nos seus algoritmos salvos.',
    installManual: 'Instruções completas, incluindo os passos manuais',
    featuresTitle: 'Tudo que um algoritmo precisa, num lugar só',
    features: [
      { h: 'Entender', p: 'Cada um dos 31 frameworks de mascaramento explicado em linguagem clara: o que faz, o que espera como entrada e o que cada parâmetro muda. Chega de deduzir pelo nome do campo.' },
      { h: 'Testar', p: 'Execute um algoritmo com um valor real e veja a saída na hora. Experimente uma configuração, mude um campo, rode de novo — o ciclo leva segundos em vez de uma execução de job.' },
      { h: 'Construir', p: 'Descreva o problema com suas palavras e receba um algoritmo configurado, salvo e pronto para rodar. Você não precisa saber de antemão qual framework usar.' },
      { h: 'Sincronizar', p: 'Conecte a um Masking Engine e espelhe a instância aqui — algoritmos, domínios, classifiers e profile sets — ou publique o seu trabalho. O que veio da instância é atualizado lá, não duplicado ao lado.' },
    ],

    syncTitle: 'Conectado à sua instância',
    syncP: 'Conecte um Masking Engine e ele vem inteiro para cá: os algoritmos, os domínios, os classifiers e os profile sets. Altere o que precisar, rode com valores reais até fazer o que deve, e devolva. A instância recebe uma atualização, não uma segunda cópia — a ferramenta lembra de onde tudo veio, e o que um objeto referencia viaja junto com ele. O que você criar do zero sobe como novo.',
    syncNote: 'Nada é enviado sem você pedir.',
    discoveryTitle: 'Encontre o dado sensível antes de mascarar',
    discoveryP: 'Mascarar começa por saber quais colunas guardam dado pessoal. A ferramenta mantém os domínios, os classifiers e os profile sets que um job de profiling roda, e testa um classifier contra uma coluna que você descreve — o nome, o tipo, alguns valores de amostra —, mostrando com que confiança o profiler decidiria e qual domínio atribuiria. Nada roda na instância.',
    presetsTitle: 'Pronto para quatro leis de proteção de dados',
    presetsP: 'Carregue um e tudo de que ele precisa é criado de uma vez: o profile set, os classifiers, os domínios que eles encontram, os algoritmos que os mascaram e os arquivos que esses leem — o pacote essencial com o mínimo para a lei, ou o estendido com tudo. Os identificadores nacionais mantêm o dígito verificador válido depois de mascarados. Cada set vem com um PDF que documenta cada item, e descarregar remove o que ele trouxe.',
    presetsDoc: 'Documentação (PDF)',
    presets: [
      { country: 'Chile', law: 'Ley 21.719', id: 'chile-ley-21719' },
      { country: 'México', law: 'LFPDPPP (2025)', id: 'mexico-lfpdppp' },
      { country: 'Panamá', law: 'Ley 81 de 2019', id: 'panama-ley-81' },
      { country: 'Belize', law: 'Data Protection Act, 2021', id: 'belize-dpa-2021' },
    ],
    assistantTitle: 'Um assistente que confere o próprio trabalho',
    assistantP: 'Descreva o que precisa mascarar e o assistente escolhe o framework e configura. Antes de salvar qualquer coisa, ele executa o algoritmo de verdade com aquela configuração — se não funcionar, nada é salvo e você é avisado do motivo. Uma configuração que parece plausível mas falha nunca chega até você.',
    assistantNote: 'Construir exige um modelo hospedado — Claude, Gemini ou GitHub Models. O modelo local padrão mantém tudo na sua máquina e aconselha: explica e recomenda, mas não salva algoritmos.',

    guideTitle: 'A referência dos frameworks',
    guideP: 'Todos os frameworks documentados por inteiro — comportamento, formato de entrada, exemplos de entrada → saída e cada parâmetro de configuração — e mais os classifiers por trás da descoberta de dado sensível. Cada exemplo foi produzido executando o framework de verdade, nunca estimado.',
    guideCta: 'Ler online',
    pdfTitle: 'Ou leve com você',
    pdfP: 'A mesma referência em PDF pronto para imprimir, um por idioma.',
    pdfCta: 'Baixar PDF',


    frameworksTitle: 'Referência dos frameworks',
    frameworksLede: 'Os 31 frameworks de mascaramento do plugin Delphix. Configure um e você tem um algoritmo. Cada par entrada → saída desta página veio de executar o framework de verdade. A Parte 10 cobre os classifiers que o profiler usa para encontrar o dado sensível.',
    backHome: 'Início',
    onThisPage: 'Nesta página',
    footerRepo: 'Código e documentação técnica no GitHub',
    footerLicense: 'Mozilla Public License 2.0. Projeto open source independente, sem relação com a Delphix nem endosso dela; as bibliotecas do produto Delphix não são distribuídas junto, e é preciso licença Delphix ativa para usar. As marcas pertencem a seus respectivos donos.',
  },

  'es': {
    title: 'Delphix Masking Helper',
    tagline: 'Construye, prueba y mantén algoritmos de enmascaramiento de Delphix — en tu propia máquina.',
    lede: 'Descubre qué framework de enmascaramiento encaja con tus datos, pruébalo con valores reales, construye una configuración lista para usar y publícala directo en tu instancia — sin crear un Rule Set ni depender de un masking job.',
    ctaRepo: 'Ver en GitHub',
    ctaFrameworks: 'Conocer los frameworks',
    demoAlt: 'Un algoritmo siendo probado, un classifier probado con una columna descrita, los profile sets que vienen con la herramienta, y una instancia Delphix conectada',
    demoCaption: 'Cuatro cosas, en este orden: ejecutar un algoritmo con un valor real; probar un classifier con una columna descrita en pantalla y ver qué dominio asignaría el profiling; los profile sets que vienen con la herramienta; y la integración con una instancia Delphix, con un algoritmo que vino de ella. Todos los valores enmascarados son salida real del plugin.',

    noticeTitle: 'Un proyecto independiente — y lo que necesitas para usarlo',
    noticeIndependent: '<strong>Sin ninguna relación con Delphix.</strong> Este es un proyecto open source independiente. No está hecho, respaldado, revisado ni soportado por Delphix ni por sus titulares, y nada aquí es un producto oficial. Delphix y los nombres de producto usados en este sitio son marcas de sus respectivos dueños.',
    noticeLicense: '<strong>Se requiere una licencia Delphix activa.</strong> Los frameworks de enmascaramiento viven en bibliotecas del producto Delphix, que este proyecto no distribuye ni sustituye. Para ejecutar la herramienta ya debes tener derecho a esas bibliotecas y poder obtener el Masking Devkit (SDK) de Delphix — normalmente mediante una licencia activa y tu equipo de cuenta.',
    ctaInstall: 'Instalar',
    installTitle: 'Instalar',
    installLede: 'Un comando. Pregunta dónde poner las cosas, comprueba que Node, Java y git estén en tu máquina — nunca los instala, solo avisa de lo que falta — y deja un comando <code>dlpx-helper</code> para arrancar y detener la app.',
    installMac: 'macOS y Linux',
    installWin: 'Windows (PowerShell)',
    installCopy: 'Copiar',
    installCopied: 'Copiado',
    installReadFirst: '¿Prefieres leerlo antes de ejecutarlo? Descarga el mismo script, ábrelo y luego ejecútalo — la página de tu sistema muestra las dos formas.',
    installAfterTitle: 'Después, un paso que solo tú puedes dar',
    installAfter: 'Copia los jars de tu Masking Devkit (SDK) a la carpeta <code>lib</code> que creó. La app abre en una pantalla que lista exactamente qué archivos faltan y dónde van.',
    installCmds: 'Una vez instalado: <code>dlpx-helper</code> arranca y abre el navegador, <code>dlpx-helper stop</code> lo detiene, <code>dlpx-helper update</code> trae la última versión. Actualizar nunca toca tus algoritmos guardados.',
    installManual: 'Instrucciones completas, incluidos los pasos manuales',
    featuresTitle: 'Todo lo que un algoritmo necesita, en un solo lugar',
    features: [
      { h: 'Entender', p: 'Cada uno de los 31 frameworks de enmascaramiento explicado en lenguaje claro: qué hace, qué espera como entrada y qué cambia cada parámetro. Se acabó deducir por el nombre del campo.' },
      { h: 'Probar', p: 'Ejecuta un algoritmo con un valor real y ve la salida al instante. Prueba una configuración, cambia un campo, vuelve a ejecutar — el ciclo dura segundos en vez de una ejecución de job.' },
      { h: 'Construir', p: 'Describe el problema con tus palabras y recibe un algoritmo configurado, guardado y listo para ejecutar. No necesitas saber de antemano qué framework usar.' },
      { h: 'Sincronizar', p: 'Conéctate a un Masking Engine y refleja la instancia aquí — algoritmos, dominios, classifiers y profile sets — o publica tu trabajo. Lo que vino de la instancia se actualiza allí, no se duplica al lado.' },
    ],

    syncTitle: 'Conectado a tu instancia',
    syncP: 'Conecta un Masking Engine y viene entero: sus algoritmos, dominios, classifiers y profile sets. Cambia lo que necesites, ejecútalo con valores reales hasta que haga lo que debe, y devuélvelo. La instancia recibe una actualización, no una segunda copia — la herramienta recuerda de dónde vino todo, y lo que un objeto referencia viaja con él. Lo que crees desde cero sube como nuevo.',
    syncNote: 'Nada se envía sin que lo pidas.',
    discoveryTitle: 'Encuentra el dato sensible antes de enmascararlo',
    discoveryP: 'Enmascarar empieza por saber qué columnas guardan datos personales. La herramienta mantiene los dominios, classifiers y profile sets que ejecuta un job de profiling, y prueba un classifier con una columna que describes — su nombre, su tipo, algunos valores de muestra —, mostrando con qué confianza decidiría el profiler y qué dominio asignaría. Nada se ejecuta en la instancia.',
    presetsTitle: 'Listo para cuatro leyes de protección de datos',
    presetsP: 'Carga uno y todo lo que necesita se crea de una vez: el profile set, sus classifiers, los dominios que encuentran, los algoritmos que los enmascaran y los archivos que estos leen — el paquete esencial con lo mínimo para la ley, o el extendido con todo. Los identificadores nacionales conservan un dígito verificador válido tras el enmascaramiento. Cada set viene con un PDF que documenta cada elemento, y quitarlo elimina lo que trajo.',
    presetsDoc: 'Documentación (PDF)',
    presets: [
      { country: 'Chile', law: 'Ley 21.719', id: 'chile-ley-21719' },
      { country: 'México', law: 'LFPDPPP (2025)', id: 'mexico-lfpdppp' },
      { country: 'Panamá', law: 'Ley 81 de 2019', id: 'panama-ley-81' },
      { country: 'Belice', law: 'Data Protection Act, 2021', id: 'belize-dpa-2021' },
    ],
    assistantTitle: 'Un asistente que revisa su propio trabajo',
    assistantP: 'Describe qué necesitas enmascarar y el asistente elige el framework y lo configura. Antes de guardar nada, ejecuta el algoritmo de verdad con esa configuración — si no funciona, no se guarda nada y se te explica por qué. Una configuración que parece plausible pero falla nunca llega hasta ti.',
    assistantNote: 'Construir requiere un modelo alojado — Claude, Gemini o GitHub Models. El modelo local por defecto lo mantiene todo en tu máquina y aconseja: explica y recomienda, pero no guarda algoritmos.',

    guideTitle: 'La referencia de los frameworks',
    guideP: 'Todos los frameworks documentados por completo — comportamiento, formato de entrada, ejemplos de entrada → salida y cada parámetro de configuración — y además los classifiers detrás del descubrimiento de dato sensible. Cada ejemplo se produjo ejecutando el framework de verdad, nunca estimado.',
    guideCta: 'Leer en línea',
    pdfTitle: 'O llévatela contigo',
    pdfP: 'La misma referencia en PDF listo para imprimir, uno por idioma.',
    pdfCta: 'Descargar PDF',


    frameworksTitle: 'Referencia de los frameworks',
    frameworksLede: 'Los 31 frameworks de enmascaramiento del plugin de Delphix. Configura uno y tienes un algoritmo. Cada par entrada → salida de esta página vino de ejecutar el framework de verdad. La Parte 10 cubre los classifiers que el profiler usa para encontrar el dato sensible.',
    backHome: 'Inicio',
    onThisPage: 'En esta página',
    footerRepo: 'Código y documentación técnica en GitHub',
    footerLicense: 'Mozilla Public License 2.0. Proyecto open source independiente, sin relación con Delphix ni respaldo suyo; las bibliotecas del producto Delphix no se distribuyen con él, y se requiere una licencia Delphix activa para usarlo. Las marcas pertenecen a sus respectivos dueños.',
  },
}
