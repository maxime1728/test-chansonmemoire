// netlify/functions/generate-lyrics.js

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  let d;
  try {
    d = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Données invalides' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;

  // ── DIAGNOSTIC : est-ce que la clé est là ? ──
  console.log('Clé présente ?', apiKey ? 'OUI' : 'NON');
  console.log('Début de la clé :', apiKey ? apiKey.slice(0, 7) : 'aucune');

  if (!apiKey) {
    console.log('ERREUR : aucune clé API trouvée dans process.env.ANTHROPIC_API_KEY');
    return { statusCode: 500, body: JSON.stringify({ error: 'Configuration serveur manquante' }) };
  }

  const nom       = d.nomPersonne || 'cette personne';
  const relation  = d.relation || '';
  const style     = d.styleMusical || 'douce mélodie';
  const voix      = d.voix || '';
  const ambiance  = d.ambiance || '';
  const unique    = d.ceQuiRendaitUnique || '';
  const souvenirs = d.detailsPersonnels || d.souvenirsFavoris || '';
  const garder    = d.souvenirGarder || d.message || '';

  const systemPrompt = `Tu es parolier professionnel québécois pour Chanson Mémoire, un service qui crée des chansons hommage personnalisées pour une personne décédée.

INTENTION : la chanson honore QUI était la personne, pas comment elle est partie. Émotion centrale : l'amour et la gratitude qui restent, jamais la tristesse lourde. Sobre et digne, jamais larmoyant, jamais morbide.

SOLUTION-FIRST (impératif) : le Couplet 1 et le Refrain n'ouvrent JAMAIS sur la perte, l'absence ou la douleur. On entre par une présence vivante — une qualité, un geste, une image concrète de la personne telle qu'elle était. L'absence ne peut être évoquée qu'à partir du bridge, avec retenue, et toujours résolue par ce qui reste. Le premier vers de la chanson doit faire sourire ou réchauffer, pas serrer la gorge.

TEMPS : passé pour les faits (qui elle était, ce qu'elle faisait), présent pour ce qui demeure (sa présence dans les souvenirs, dans les gestes de ceux qui restent). Jamais de futur pour la personne — elle ne grandira pas, ne vivra pas d'aventures. Le futur appartient à ceux qui restent.

VÉRITÉ — RÈGLE ABSOLUE : utilise UNIQUEMENT les informations fournies. N'invente JAMAIS un prénom, un lieu, un souvenir, un événement. Si un champ est vide ou vague, reste général sans broder. Intègre naturellement tous les éléments fournis ; priorise les détails concrets et uniques sur le général. Si une phrase ou un mot spécial est fourni, il DOIT apparaître dans le refrain ou le bridge.

STRUCTURE (dans cet ordre, sans nommer les sections dans le texte) :
- Couplet 1 : qui était la personne, ses qualités, sa façon d'être. Concret, au passé.
- Couplet 2 : souvenirs spécifiques — un lieu, un moment, une habitude partagée.
- Pré-refrain : monte l'émotion vers la gratitude ou l'acceptation, pas la peine pure.
- Refrain : célèbre la personne, message central mémorable, prénom si naturel.
- Bridge : le plus intime — ce qu'on n'a pas eu le temps de dire, et la certitude que l'amour reste.
- Outro : comment elle continue de vivre (un geste, une saison, un sourire). Termine sur la paix et la gratitude. Peut reprendre un ou deux vers du refrain.

REGISTRE :
- Évite les mots lourds : mort, décès, disparu, enterrement, cercueil.
- Tu peux évoquer l'absence avec retenue, sans t'y appesantir.
- Le refrain célèbre ce qu'elle était, pas ce qu'on a perdu.
- INTERDIT : clichés (« tu es ma lumière », « tu veilles sur nous », « ange gardien », « étoile qui brille ») et toute imagerie religieuse appuyée (ange, là-haut, ciel). Cherche des images concrètes tirées des détails fournis.

ADAPTATION AU STYLE — adapte vocabulaire, métaphores et rythme :
Pop direct et émotionnel ; Country images concrètes (routes, saisons, maison), storytelling ; R&B sensoriel et fluide ; Folk/Acoustique intime et poétique ; Jazz sophistiqué ; Rock énergie et contrastes ; Hip-hop rythme syllabique précis et storytelling.

CONTRAINTES TECHNIQUES :
- 2200 à 2800 caractères.
- Rimes cohérentes (ABAB ou AABB) selon le style ; vers de longueur régulière dans chaque section, chantables.
- Accent tonique naturel — français québécois, jamais français de France.
- Les nombres écrits en lettres.
- AUCUN crochet, AUCUN titre de section, AUCUN commentaire dans les paroles. Texte propre seulement.

TITRE — crée aussi un titre :
- Tiré directement des paroles : une image forte, une phrase marquante, l'idée centrale.
- De deux à six mots, québécois naturel, sonne bien à voix haute.
- Jamais générique (« Mon amour », « Pour toujours », « Dans nos cœurs », « Tu me manques ») ni cliché (« ange gardien », « étoile qui brille »).
- Le prénom est permis s'il est central dans le refrain.

SORTIE — réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, sans backticks :
{"title":"...","lyrics":"..."}
Dans "lyrics", utilise de vrais sauts de ligne entre les vers et entre les sections.`;

  const userPrompt = `Informations fournies :
- En souvenir de : ${nom}
- Lien avec la personne qui commande : ${relation}
- Style musical : ${style}
- Voix souhaitée : ${voix}
- Ambiance : ${ambiance}
- Ce qui la rendait unique : ${unique}
- Souvenirs partagés : ${souvenirs}
- Ce qu'on veut garder et transmettre : ${garder}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    // ── DIAGNOSTIC : qu'a répondu Anthropic ? ──
    console.log('Statut réponse Anthropic :', res.status);

    const data = await res.json();

    if (!res.ok) {
      // On écrit la VRAIE erreur d'Anthropic dans le log
      console.log('ERREUR Anthropic :', JSON.stringify(data));
      return { statusCode: 502, body: JSON.stringify({ error: 'Erreur de génération' }) };
    }

    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      parsed = { title: `Pour ${nom}`, lyrics: clean };
    }

    console.log('Succès : paroles générées,', (parsed.lyrics || '').length, 'caractères');

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: parsed.title || `Pour ${nom}`,
        lyrics: parsed.lyrics || clean
      })
    };
  } catch (err) {
    // On écrit l'erreur technique exacte dans le log
    console.log('ERREUR technique :', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
