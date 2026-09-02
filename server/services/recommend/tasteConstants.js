// Mood cards for the taste quiz. Each mood expands into genre and/or keyword
// names (matched case-insensitively against TMDB keyword names) with a
// sentiment. Kept server-side so the quiz UI and the profile expansion can't
// drift apart — the UI fetches this list via /api/user/taste/suggest?type=mood.

const MOODS = [
  {
    id: 'superhero-fatigue',
    label: 'Superhero fatigue',
    description: 'Fewer capes, comic-book franchises and cinematic universes',
    sentiment: 'avoid',
    keywords: ['superhero', 'based on comic', 'superhero team', 'super power',
      'marvel cinematic universe (mcu)', 'dc extended universe (dceu)', 'masked superhero'],
  },
  {
    id: 'slow-burn',
    label: 'Slow-burn stories',
    description: 'Deliberate pacing, character studies, quiet tension',
    sentiment: 'love',
    keywords: ['slow burn', 'character study', 'melancholy', 'contemplative'],
  },
  {
    id: 'comfort-tv',
    label: 'Comfort watches',
    description: 'Sitcoms, feel-good shows, easy rewatches',
    sentiment: 'love',
    genres: ['Comedy'],
    keywords: ['sitcom', 'feel good', 'workplace comedy', 'friendship'],
  },
  {
    id: 'mind-benders',
    label: 'Mind-benders',
    description: 'Twists, nonlinear timelines, unreliable narrators',
    sentiment: 'love',
    keywords: ['plot twist', 'nonlinear timeline', 'mindbender', 'surrealism', 'time loop'],
  },
  {
    id: 'true-crime',
    label: 'True crime & docs',
    description: 'Documentaries, investigations, real events',
    sentiment: 'love',
    genres: ['Documentary'],
    keywords: ['true crime', 'based on true story', 'investigation'],
  },
  {
    id: 'no-horror',
    label: 'No scares please',
    description: 'Skip horror, gore and jump scares',
    sentiment: 'avoid',
    genres: ['Horror'],
    keywords: ['gore', 'slasher', 'jump scare', 'body horror'],
  },
  {
    id: 'epic-fantasy',
    label: 'Epic fantasy & sci-fi',
    description: 'World-building, space opera, sweeping sagas',
    sentiment: 'love',
    genres: ['Fantasy', 'Science Fiction'],
    keywords: ['space opera', 'epic', 'world building', 'sword and sorcery', 'dystopia'],
  },
  {
    id: 'no-romance',
    label: 'Light on romance',
    description: 'Romance-driven plots are not for me',
    sentiment: 'avoid',
    genres: ['Romance'],
    keywords: ['romantic comedy', 'love triangle'],
  },
  {
    id: 'anime-fan',
    label: 'Anime enjoyer',
    description: 'More anime series and films',
    sentiment: 'love',
    genres: ['Anime', 'Animation'],
    keywords: ['anime', 'shounen', 'seinen'],
  },
  {
    id: 'no-reality',
    label: 'No reality TV',
    description: 'Skip reality shows and talent competitions',
    sentiment: 'avoid',
    genres: ['Reality'],
    keywords: ['reality tv', 'talent show', 'competition'],
  },
];

module.exports = { MOODS };
