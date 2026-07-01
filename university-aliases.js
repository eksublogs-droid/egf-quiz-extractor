/* ════════════════════════════════════════════════════════
   EduGlobalForge — University Alias List (university-aliases.js)
   Standalone data file. Does NOT contain any matching logic —
   that lives in drive-push.js. This file just holds the lookup
   table so you can add new schools without touching any code.

   Include this BEFORE drive-push.js:
     <script src="university-aliases.js"></script>
     <script src="drive-push.js"></script>

   HOW TO ADD A NEW SCHOOL:
   Just add a new line below in this exact pattern:
     'acronym': 'Full Official Name (ACRONYM)',
   - The key must be lowercase, letters/numbers only (no spaces, no dots).
   - The value MUST contain the institution type word
     (University / Polytechnic / College / Institute) somewhere in it —
     that's how the matching code tells "Delta State University" apart
     from "Delta State Polytechnic".
   ════════════════════════════════════════════════════════ */

const UNIVERSITY_ALIASES = {

  /* ── Federal Universities ── */
  'unilag':    'University of Lagos (UNILAG)',
  'ui':        'University of Ibadan (UI)',
  'oau':       'Obafemi Awolowo University (OAU)',
  'unn':       'University of Nigeria, Nsukka (UNN)',
  'abu':       'Ahmadu Bello University (ABU)',
  'uniben':    'University of Benin (UNIBEN)',
  'unijos':    'University of Jos (UNIJOS)',
  'unical':    'University of Calabar (UNICAL)',
  'unimaid':   'University of Maiduguri (UNIMAID)',
  'buk':       'Bayero University, Kano (BUK)',
  'uniport':   'University of Port Harcourt (UNIPORT)',
  'futa':      'Federal University of Technology, Akure (FUTA)',
  'futo':      'Federal University of Technology, Owerri (FUTO)',
  'futminna':  'Federal University of Technology, Minna (FUTMINNA)',
  'atbu':      'Abubakar Tafawa Balewa University (ATBU)',
  'udus':      'Usmanu Danfodiyo University, Sokoto (UDUS)',
  'funaab':    'Federal University of Agriculture, Abeokuta (FUNAAB)',
  'uniabuja':  'University of Abuja (UNIABUJA)',
  'fuoye':     'Federal University Oye-Ekiti (FUOYE)',
  'fudma':     'Federal University Dutsin-Ma (FUDMA)',
  'fulokoja':  'Federal University Lokoja (FULOKOJA)',
  'fukashere': 'Federal University Kashere (FUKASHERE)',
  'fugusau':   'Federal University Gusau (FUGUSAU)',
  'funai':     'Federal University Ndufu-Alike (FUNAI)',
  'mouau':     'Michael Okpara University of Agriculture, Umudike (MOUAU)',
  'noun':      'National Open University of Nigeria (NOUN)',
  'unizik':    'Nnamdi Azikiwe University (UNIZIK)',

  /* ── State Universities ── */
  'eksu':      'Ekiti State University (EKSU)',
  'lasu':      'Lagos State University (LASU)',
  'delsu':     'Delta State University (DELSU)',
  'rsu':       'Rivers State University (RSU)',
  'absu':      'Abia State University (ABSU)',
  'imsu':      'Imo State University (IMSU)',
  'esut':      'Enugu State University of Science and Technology (ESUT)',
  'aaua':      'Adekunle Ajasin University, Akungba-Akoko (AAUA)',
  'aau':       'Ambrose Alli University (AAU)',
  'oou':       'Olabisi Onabanjo University (OOU)',
  'tasued':    'Tai Solarin University of Education (TASUED)',
  'lautech':   'Ladoke Akintola University of Technology (LAUTECH)',
  'uniosun':   'Osun State University (UNIOSUN)',
  'ebsu':      'Ebonyi State University (EBSU)',
  'kwasu':     'Kwara State University (KWASU)',
  'bsu':       'Benue State University (BSU)',
  'kasu':      'Kaduna State University (KASU)',
  'umyu':      'Umaru Musa Yar\'adua University, Katsina (UMYU)',
  'nsuk':      'Nasarawa State University, Keffi (NSUK)',
  'gsu':       'Gombe State University (GSU)',
  'plasu':     'Plateau State University (PLASU)',
  'tsu':       'Taraba State University (TSU)',
  'adsu':      'Adamawa State University (ADSU)',
  'ysu':       'Yobe State University (YSU)',
  'aksu':      'Akwa Ibom State University (AKSU)',
  'crutech':   'Cross River University of Technology (CRUTECH)',
  'coou':      'Chukwuemeka Odumegwu Ojukwu University (COOU)',
  'bosu':      'Borno State University (BOSU)',

  /* ── Private Universities ── */
  'covenant':  'Covenant University (COVENANT)',
  'bowen':     'Bowen University (BOWEN)',
  'babcock':   'Babcock University (BABCOCK)',
  'run':       'Redeemer\'s University (RUN)',
  'abuad':     'Afe Babalola University, Ado-Ekiti (ABUAD)',
  'lmu':       'Landmark University (LMU)',
  'pau':       'Pan-Atlantic University (PAU)',
  'elizade':   'Elizade University (ELIZADE)',
  'bells':     'Bells University of Technology (BELLS)',
  'aun':       'American University of Nigeria (AUN)',
  'lcu':       'Lead City University (LCU)',
  'caleb':     'Caleb University (CALEB)',
  'igbinedion':'Igbinedion University (IGBINEDION)',
  'mcpherson': 'McPherson University (MCPHERSON)',

  /* ── Polytechnics (kept separate from same-named universities on purpose) ── */
  'yabatech':    'Yaba College of Technology (YABATECH)',
  'fedpoffa':    'Federal Polytechnic, Offa (FEDPOFFA)',
  'fedpolyado':  'Federal Polytechnic, Ado-Ekiti (FEDPOLYADO)',
  'kwarapoly':   'Kwara State Polytechnic (KWARAPOLY)',
  'auchipoly':   'Auchi Polytechnic (AUCHIPOLY)',
  'imopoly':     'Imo State Polytechnic (IMOPOLY)',
  'laspotech':   'Lagos State Polytechnic (LASPOTECH)',

  /* ── Colleges of Education ── */
  'eksucoed':  'Ekiti State College of Education, Ikere-Ekiti (EKSUCOED)',
  'aacoed':    'Adeyemi Federal University of Education, Ondo (AACOED)',

  /* ── Add new schools below this line ── */

};
