/**
 * Copy for the GitHub Pages site, in the three languages the project supports.
 *
 * The landing page is deliberately non-technical: it says what the tool is for and who it
 * helps, and sends anyone who wants jars, ports and build steps to the repository README.
 * The algorithm pages carry the reference content, generated from docs/src/guide.<locale>.html.
 */

export const REPO = 'https://github.com/adelbs/delphix-masking-helper'

export const LANG_NAMES = { 'en': 'English', 'pt-BR': 'Português', 'es': 'Español' }
export const LANG_ABBR  = { 'en': 'EN', 'pt-BR': 'PT', 'es': 'ES' }

/** File names on the site. English is the site root; the others sit beside it. */
export const PAGES = {
  'en':    { home: 'index.html',          algos: 'algorithms.html',      htmlLang: 'en' },
  'pt-BR': { home: 'index.pt-BR.html',    algos: 'algorithms.pt-BR.html', htmlLang: 'pt-BR' },
  'es':    { home: 'index.es.html',       algos: 'algorithms.es.html',   htmlLang: 'es' },
}

export const T = {
  'en': {
    title: 'Delphix Masking Helper',
    tagline: 'Understand, test and build Delphix masking algorithms — on your own machine.',
    lede: 'Work out which masking framework fits your data, try it against real values, and get a ready-to-use configuration — without creating a Rule Set or waiting on a Masking Engine.',
    ctaRepo: 'View on GitHub',
    ctaAlgos: 'Browse the algorithms',
    demoAlt: 'The assistant choosing an algorithm, configuring it, and the configuration being tested',
    demoCaption: 'Describing a problem in plain language; the assistant picks the framework, configures it, and the result is real output from the plugin.',

    featuresTitle: 'Three things it does well',
    features: [
      { h: 'Understand', p: 'Each of the 31 masking frameworks explained in plain language: what it does, what it expects as input, and what every parameter changes. No more guessing from a parameter name.' },
      { h: 'Test', p: 'Run an algorithm against a real value and see the output immediately. Try a configuration, change one field, run it again — the loop takes seconds instead of a job run.' },
      { h: 'Build', p: 'Describe the problem in your own words and get back a configured algorithm, saved and ready to run. You do not need to know which framework to reach for.' },
    ],

    assistantTitle: 'An assistant that checks its own work',
    assistantP: 'Describe what you need to mask and the assistant picks the framework and configures it. Before anything is saved it actually runs the algorithm with that configuration — if it does not work, nothing is saved and you are told why. A configuration that looks plausible but fails never reaches you.',
    assistantNote: 'It runs against a local model by default, so nothing leaves your machine.',

    guideTitle: 'The algorithm reference',
    guideP: 'Every framework documented in full — behaviour, input format, worked input → output examples and every configuration parameter. Each example was produced by actually running the algorithm, never estimated.',
    guideCta: 'Read it online',
    pdfTitle: 'Or take it with you',
    pdfP: 'The same reference as a printable PDF, one per language.',
    pdfCta: 'Download PDF',

    langTitle: 'In your language',
    langP: 'The application, this site and the reference guide are all available in English, Portuguese and Spanish.',

    algosTitle: 'Algorithm reference',
    algosLede: 'All 31 masking frameworks in the Delphix plugin. Every input → output pair on this page came from actually running the algorithm.',
    backHome: 'Home',
    onThisPage: 'On this page',
    footerRepo: 'Source and technical documentation on GitHub',
    footerLicense: 'Mozilla Public License 2.0. Delphix product libraries are not distributed with the project.',
  },

  'pt-BR': {
    title: 'Delphix Masking Helper',
    tagline: 'Entenda, teste e construa algoritmos de mascaramento do Delphix — na sua própria máquina.',
    lede: 'Descubra qual framework de mascaramento serve para o seu dado, experimente com valores reais e receba uma configuração pronta para usar — sem criar Rule Set nem depender de um Masking Engine.',
    ctaRepo: 'Ver no GitHub',
    ctaAlgos: 'Conhecer os algoritmos',
    demoAlt: 'O assistente escolhendo um algoritmo, configurando e a configuração sendo testada',
    demoCaption: 'Descrevendo um problema em linguagem comum; o assistente escolhe o framework, configura, e o resultado é saída real do plugin.',

    featuresTitle: 'Três coisas que ele faz bem',
    features: [
      { h: 'Entender', p: 'Cada um dos 31 frameworks de mascaramento explicado em linguagem clara: o que faz, o que espera como entrada e o que cada parâmetro muda. Chega de deduzir pelo nome do campo.' },
      { h: 'Testar', p: 'Execute um algoritmo com um valor real e veja a saída na hora. Experimente uma configuração, mude um campo, rode de novo — o ciclo leva segundos em vez de uma execução de job.' },
      { h: 'Construir', p: 'Descreva o problema com suas palavras e receba um algoritmo configurado, salvo e pronto para rodar. Você não precisa saber de antemão qual framework usar.' },
    ],

    assistantTitle: 'Um assistente que confere o próprio trabalho',
    assistantP: 'Descreva o que precisa mascarar e o assistente escolhe o framework e configura. Antes de salvar qualquer coisa, ele executa o algoritmo de verdade com aquela configuração — se não funcionar, nada é salvo e você é avisado do motivo. Uma configuração que parece plausível mas falha nunca chega até você.',
    assistantNote: 'Por padrão roda com um modelo local, então nada sai da sua máquina.',

    guideTitle: 'A referência dos algoritmos',
    guideP: 'Todos os frameworks documentados por inteiro — comportamento, formato de entrada, exemplos de entrada → saída e cada parâmetro de configuração. Cada exemplo foi produzido executando o algoritmo de verdade, nunca estimado.',
    guideCta: 'Ler online',
    pdfTitle: 'Ou leve com você',
    pdfP: 'A mesma referência em PDF pronto para imprimir, um por idioma.',
    pdfCta: 'Baixar PDF',

    langTitle: 'No seu idioma',
    langP: 'A aplicação, este site e o guia de referência estão disponíveis em inglês, português e espanhol.',

    algosTitle: 'Referência dos algoritmos',
    algosLede: 'Os 31 frameworks de mascaramento do plugin Delphix. Cada par entrada → saída desta página veio de executar o algoritmo de verdade.',
    backHome: 'Início',
    onThisPage: 'Nesta página',
    footerRepo: 'Código e documentação técnica no GitHub',
    footerLicense: 'Mozilla Public License 2.0. As bibliotecas do produto Delphix não são distribuídas com o projeto.',
  },

  'es': {
    title: 'Delphix Masking Helper',
    tagline: 'Entiende, prueba y construye algoritmos de enmascaramiento de Delphix — en tu propia máquina.',
    lede: 'Descubre qué framework de enmascaramiento encaja con tus datos, pruébalo con valores reales y obtén una configuración lista para usar — sin crear un Rule Set ni depender de un Masking Engine.',
    ctaRepo: 'Ver en GitHub',
    ctaAlgos: 'Conocer los algoritmos',
    demoAlt: 'El asistente eligiendo un algoritmo, configurándolo y la configuración siendo probada',
    demoCaption: 'Describiendo un problema en lenguaje corriente; el asistente elige el framework, lo configura, y el resultado es salida real del plugin.',

    featuresTitle: 'Tres cosas que hace bien',
    features: [
      { h: 'Entender', p: 'Cada uno de los 31 frameworks de enmascaramiento explicado en lenguaje claro: qué hace, qué espera como entrada y qué cambia cada parámetro. Se acabó deducir por el nombre del campo.' },
      { h: 'Probar', p: 'Ejecuta un algoritmo con un valor real y ve la salida al instante. Prueba una configuración, cambia un campo, vuelve a ejecutar — el ciclo dura segundos en vez de una ejecución de job.' },
      { h: 'Construir', p: 'Describe el problema con tus palabras y recibe un algoritmo configurado, guardado y listo para ejecutar. No necesitas saber de antemano qué framework usar.' },
    ],

    assistantTitle: 'Un asistente que revisa su propio trabajo',
    assistantP: 'Describe qué necesitas enmascarar y el asistente elige el framework y lo configura. Antes de guardar nada, ejecuta el algoritmo de verdad con esa configuración — si no funciona, no se guarda nada y se te explica por qué. Una configuración que parece plausible pero falla nunca llega hasta ti.',
    assistantNote: 'Por defecto funciona con un modelo local, así que nada sale de tu máquina.',

    guideTitle: 'La referencia de los algoritmos',
    guideP: 'Todos los frameworks documentados por completo — comportamiento, formato de entrada, ejemplos de entrada → salida y cada parámetro de configuración. Cada ejemplo se produjo ejecutando el algoritmo de verdad, nunca estimado.',
    guideCta: 'Leer en línea',
    pdfTitle: 'O llévatela contigo',
    pdfP: 'La misma referencia en PDF listo para imprimir, uno por idioma.',
    pdfCta: 'Descargar PDF',

    langTitle: 'En tu idioma',
    langP: 'La aplicación, este sitio y la guía de referencia están disponibles en inglés, portugués y español.',

    algosTitle: 'Referencia de los algoritmos',
    algosLede: 'Los 31 frameworks de enmascaramiento del plugin de Delphix. Cada par entrada → salida de esta página vino de ejecutar el algoritmo de verdad.',
    backHome: 'Inicio',
    onThisPage: 'En esta página',
    footerRepo: 'Código y documentación técnica en GitHub',
    footerLicense: 'Mozilla Public License 2.0. Las bibliotecas del producto Delphix no se distribuyen con el proyecto.',
  },
}
