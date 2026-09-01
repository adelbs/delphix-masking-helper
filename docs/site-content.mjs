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
    tagline: 'Build, test and maintain Delphix masking algorithms — on your own machine.',
    lede: 'Work out which masking framework fits your data, try it against real values, build a ready-to-use configuration and push it straight to your engine — without creating a Rule Set or waiting on a masking job.',
    ctaRepo: 'View on GitHub',
    ctaAlgos: 'Browse the algorithms',
    demoAlt: 'The assistant building an algorithm, an algorithm being tested, and algorithms being synced with a Delphix engine',
    demoCaption: 'Three things, in order: asking the assistant for an algorithm and watching it build and validate one; running an algorithm against a real value; importing from a Delphix engine and sending one back. Every masked value is real output from the plugin.',

    noticeTitle: 'An independent project — and what you need to use it',
    noticeIndependent: '<strong>No affiliation with Delphix.</strong> This is an independent open source project. It is not built, endorsed, reviewed or supported by Delphix or its owners, and nothing here is an official product. Delphix and the product names used on this site are trademarks of their respective owners.',
    noticeLicense: '<strong>An active Delphix licence is required.</strong> The masking algorithms live in Delphix product libraries, which this project does not distribute and cannot replace. To run the tool you must already be entitled to those libraries and able to obtain the Masking Devkit (SDK) from Delphix — normally through an active licence and your account team.',
    featuresTitle: 'Everything an algorithm needs, in one place',
    features: [
      { h: 'Understand', p: 'Each of the 31 masking frameworks explained in plain language: what it does, what it expects as input, and what every parameter changes. No more guessing from a parameter name.' },
      { h: 'Test', p: 'Run an algorithm against a real value and see the output immediately. Try a configuration, change one field, run it again — the loop takes seconds instead of a job run.' },
      { h: 'Build', p: 'Describe the problem in your own words and get back a configured algorithm, saved and ready to run. You do not need to know which framework to reach for.' },
      { h: 'Sync', p: 'Connect to a Masking Engine and pull its algorithms down to work on, or push yours up. An algorithm that came from the engine is updated there, not duplicated beside it.' },
    ],

    syncTitle: 'Connected to your engine',
    syncP: 'Point the tool at a Masking Engine and its algorithms are yours to work on: pull one down, change it, run it against real values until it does what you need, and send it back. The engine gets an update, not a second copy — the tool remembers where each algorithm came from. Anything you build from scratch goes up as a new algorithm.',
    syncNote: 'Nothing is sent anywhere until you ask for it.',
    assistantTitle: 'An assistant that checks its own work',
    assistantP: 'Describe what you need to mask and the assistant picks the framework and configures it. Before anything is saved it actually runs the algorithm with that configuration — if it does not work, nothing is saved and you are told why. A configuration that looks plausible but fails never reaches you.',
    assistantNote: 'It runs against a local model by default, so nothing leaves your machine.',

    guideTitle: 'The algorithm reference',
    guideP: 'Every framework documented in full — behaviour, input format, worked input → output examples and every configuration parameter. Each example was produced by actually running the algorithm, never estimated.',
    guideCta: 'Read it online',
    pdfTitle: 'Or take it with you',
    pdfP: 'The same reference as a printable PDF, one per language.',
    pdfCta: 'Download PDF',


    algosTitle: 'Algorithm reference',
    algosLede: 'All 31 masking frameworks in the Delphix plugin. Every input → output pair on this page came from actually running the algorithm.',
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
    ctaAlgos: 'Conhecer os algoritmos',
    demoAlt: 'O assistente construindo um algoritmo, um algoritmo sendo testado, e algoritmos sendo sincronizados com uma instância Delphix',
    demoCaption: 'Três coisas, nesta ordem: pedir um algoritmo ao assistente e vê-lo construir e validar um; executar um algoritmo com um valor real; importar de uma instância Delphix e devolver um. Todos os valores mascarados são saída real do plugin.',

    noticeTitle: 'Um projeto independente — e o que você precisa para usar',
    noticeIndependent: '<strong>Sem qualquer relação com a Delphix.</strong> Este é um projeto open source independente. Não é feito, endossado, revisado nem suportado pela Delphix ou por seus detentores, e nada aqui é produto oficial. Delphix e os nomes de produto citados neste site são marcas de seus respectivos donos.',
    noticeLicense: '<strong>É necessária uma licença Delphix ativa.</strong> Os algoritmos de mascaramento vivem em bibliotecas do produto Delphix, que este projeto não distribui e não substitui. Para rodar a ferramenta você já precisa ter direito a essas bibliotecas e conseguir o Masking Devkit (SDK) com a Delphix — normalmente por meio de uma licença ativa e do seu time de conta.',
    featuresTitle: 'Tudo que um algoritmo precisa, num lugar só',
    features: [
      { h: 'Entender', p: 'Cada um dos 31 frameworks de mascaramento explicado em linguagem clara: o que faz, o que espera como entrada e o que cada parâmetro muda. Chega de deduzir pelo nome do campo.' },
      { h: 'Testar', p: 'Execute um algoritmo com um valor real e veja a saída na hora. Experimente uma configuração, mude um campo, rode de novo — o ciclo leva segundos em vez de uma execução de job.' },
      { h: 'Construir', p: 'Descreva o problema com suas palavras e receba um algoritmo configurado, salvo e pronto para rodar. Você não precisa saber de antemão qual framework usar.' },
      { h: 'Sincronizar', p: 'Conecte a um Masking Engine e traga os algoritmos dele para trabalhar, ou publique os seus. Um algoritmo que veio da instância é atualizado lá, não duplicado ao lado.' },
    ],

    syncTitle: 'Conectado à sua instância',
    syncP: 'Aponte a ferramenta para um Masking Engine e os algoritmos dele passam a estar ao seu alcance: traga um para cá, altere, rode com valores reais até fazer o que você precisa, e devolva. A instância recebe uma atualização, não uma segunda cópia — a ferramenta lembra de onde cada algoritmo veio. O que você criar do zero sobe como algoritmo novo.',
    syncNote: 'Nada é enviado sem você pedir.',
    assistantTitle: 'Um assistente que confere o próprio trabalho',
    assistantP: 'Descreva o que precisa mascarar e o assistente escolhe o framework e configura. Antes de salvar qualquer coisa, ele executa o algoritmo de verdade com aquela configuração — se não funcionar, nada é salvo e você é avisado do motivo. Uma configuração que parece plausível mas falha nunca chega até você.',
    assistantNote: 'Por padrão roda com um modelo local, então nada sai da sua máquina.',

    guideTitle: 'A referência dos algoritmos',
    guideP: 'Todos os frameworks documentados por inteiro — comportamento, formato de entrada, exemplos de entrada → saída e cada parâmetro de configuração. Cada exemplo foi produzido executando o algoritmo de verdade, nunca estimado.',
    guideCta: 'Ler online',
    pdfTitle: 'Ou leve com você',
    pdfP: 'A mesma referência em PDF pronto para imprimir, um por idioma.',
    pdfCta: 'Baixar PDF',


    algosTitle: 'Referência dos algoritmos',
    algosLede: 'Os 31 frameworks de mascaramento do plugin Delphix. Cada par entrada → saída desta página veio de executar o algoritmo de verdade.',
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
    ctaAlgos: 'Conocer los algoritmos',
    demoAlt: 'El asistente construyendo un algoritmo, un algoritmo siendo probado, y algoritmos sincronizándose con una instancia Delphix',
    demoCaption: 'Tres cosas, en este orden: pedir un algoritmo al asistente y verlo construir y validar uno; ejecutar un algoritmo con un valor real; importar de una instancia Delphix y devolver uno. Todos los valores enmascarados son salida real del plugin.',

    noticeTitle: 'Un proyecto independiente — y lo que necesitas para usarlo',
    noticeIndependent: '<strong>Sin ninguna relación con Delphix.</strong> Este es un proyecto open source independiente. No está hecho, respaldado, revisado ni soportado por Delphix ni por sus titulares, y nada aquí es un producto oficial. Delphix y los nombres de producto usados en este sitio son marcas de sus respectivos dueños.',
    noticeLicense: '<strong>Se requiere una licencia Delphix activa.</strong> Los algoritmos de enmascaramiento viven en bibliotecas del producto Delphix, que este proyecto no distribuye ni sustituye. Para ejecutar la herramienta ya debes tener derecho a esas bibliotecas y poder obtener el Masking Devkit (SDK) de Delphix — normalmente mediante una licencia activa y tu equipo de cuenta.',
    featuresTitle: 'Todo lo que un algoritmo necesita, en un solo lugar',
    features: [
      { h: 'Entender', p: 'Cada uno de los 31 frameworks de enmascaramiento explicado en lenguaje claro: qué hace, qué espera como entrada y qué cambia cada parámetro. Se acabó deducir por el nombre del campo.' },
      { h: 'Probar', p: 'Ejecuta un algoritmo con un valor real y ve la salida al instante. Prueba una configuración, cambia un campo, vuelve a ejecutar — el ciclo dura segundos en vez de una ejecución de job.' },
      { h: 'Construir', p: 'Describe el problema con tus palabras y recibe un algoritmo configurado, guardado y listo para ejecutar. No necesitas saber de antemano qué framework usar.' },
      { h: 'Sincronizar', p: 'Conéctate a un Masking Engine y trae sus algoritmos para trabajar, o publica los tuyos. Un algoritmo que vino de la instancia se actualiza allí, no se duplica al lado.' },
    ],

    syncTitle: 'Conectado a tu instancia',
    syncP: 'Apunta la herramienta a un Masking Engine y sus algoritmos quedan a tu alcance: trae uno, modifícalo, ejecútalo con valores reales hasta que haga lo que necesitas, y devuélvelo. La instancia recibe una actualización, no una segunda copia — la herramienta recuerda de dónde vino cada algoritmo. Lo que crees desde cero sube como algoritmo nuevo.',
    syncNote: 'Nada se envía sin que lo pidas.',
    assistantTitle: 'Un asistente que revisa su propio trabajo',
    assistantP: 'Describe qué necesitas enmascarar y el asistente elige el framework y lo configura. Antes de guardar nada, ejecuta el algoritmo de verdad con esa configuración — si no funciona, no se guarda nada y se te explica por qué. Una configuración que parece plausible pero falla nunca llega hasta ti.',
    assistantNote: 'Por defecto funciona con un modelo local, así que nada sale de tu máquina.',

    guideTitle: 'La referencia de los algoritmos',
    guideP: 'Todos los frameworks documentados por completo — comportamiento, formato de entrada, ejemplos de entrada → salida y cada parámetro de configuración. Cada ejemplo se produjo ejecutando el algoritmo de verdad, nunca estimado.',
    guideCta: 'Leer en línea',
    pdfTitle: 'O llévatela contigo',
    pdfP: 'La misma referencia en PDF listo para imprimir, uno por idioma.',
    pdfCta: 'Descargar PDF',


    algosTitle: 'Referencia de los algoritmos',
    algosLede: 'Los 31 frameworks de enmascaramiento del plugin de Delphix. Cada par entrada → salida de esta página vino de ejecutar el algoritmo de verdad.',
    backHome: 'Inicio',
    onThisPage: 'En esta página',
    footerRepo: 'Código y documentación técnica en GitHub',
    footerLicense: 'Mozilla Public License 2.0. Proyecto open source independiente, sin relación con Delphix ni respaldo suyo; las bibliotecas del producto Delphix no se distribuyen con él, y se requiere una licencia Delphix activa para usarlo. Las marcas pertenecen a sus respectivos dueños.',
  },
}
