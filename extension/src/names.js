// Name dictionary for PERSON_NAME detection. Lowercase. Not exhaustive:
// extend it per organisation (admins can also add names as policy keywords).
//
// AMBIGUOUS: first names that are also everyday English words. These only
// count as a name when paired with a surname or a name cue ("my name is").

(function (root) {
  "use strict";

  const FIRST = `
  thabo sipho themba bongani mandla sibusiso lwazi lungile lindiwe nomvula nokuthula nonhlanhla
  thandeka thandiwe zanele zodwa zinhle ayanda andile siyabonga sifiso sizwe sandile mzwandile
  musa nkosinathi njabulo nhlanhla phumzile palesa lerato refilwe kagiso karabo katlego kabelo
  tshepo tshepiso tumelo thato teboho lebohang mpho mpumi mpumelelo neo naledi nthabiseng
  dineo boitumelo bonolo keabetswe kamogelo lesedi lehlohonolo letlotlo masego mmabatho
  onkarabile oratile reitumetse rethabile tebogo tlotlo tumi zandile zola zukisa zama zinzi
  xolani xolisa vuyo vuyani vusi lunga luthando lulama lusanda lindani lindokuhle khanyisile
  khaya khanya kgothatso kgomotso kamva hlengiwe hlumelo gugu fezile fikile dumisani dumisa
  bheki bhekithemba busisiwe buhle cebo celiwe duduzile mbali mbalenhle minenhle nosipho
  nompumelelo nozipho olwethu ofentse oarabile sibongile simphiwe sinethemba siphesihle sithembiso
  solomzi thembeka thembisile thulani unathi wandile yonela zizipho zintle akhona amahle anele
  asanda azola bandile banele bulelani buyisiwe khulekani khumbulani langa lethabo lethu
  mthunzi mxolisi ndumiso nomsa nosizwe oyama phindile siviwe sizakele thobeka thokozani
  tinyiko tsakani hlulani rhulani ntsako nyiko murendeni rendani tshilidzi takalani
  mulalo fulufhelo ndivhuwo pfano khathu livhuwani rofhiwa
  johan johannes jan jacobus pieter piet hendrik hennie gerhard gert willem wim andries
  francois frikkie stefan stephanus christo christiaan riaan ruan rudolf rassie danie
  deon dawid izak koos kobus marius morne neels petrus schalk theuns tiaan wikus wynand
  anri annelie anel carien charlize elmarie elsabe estelle hanlie hester ilse ilze karin
  liezel lizelle mariska marlize mienkie nadia nelmarie retha riana rina sanet sonja suzette
  tanja tersia wilma yolande zelda zanele
  priya pravesh praveen preshen kumaran kevin kavitha kamini nirvana nishaan nikhil rajesh
  rakesh ravi reshma roshan sanjay sanjeev shamila shireen sunil suresh thirusha vishal
  yashica zaheer zaid ayesha fatima farhana nazeem naeem rashid riaz shaheed yusuf
  mohammed muhammad ahmed ali hassan ibrahim ismail omar
  john james michael david peter paul mark andrew richard robert william thomas charles
  joseph daniel matthew anthony christopher steven brian kevin jason ryan justin brandon
  craig dean dylan gareth grant graham greg keith kyle lance liam luke nathan neil nicholas
  quinton reece riley sean shane simon stuart travis trevor tyrone warren wayne
  mary patricia jennifer linda elizabeth barbara susan jessica sarah karen nancy lisa
  margaret sandra ashley kimberly emily donna michelle carol amanda melissa deborah
  stephanie rebecca sharon laura cynthia kathleen amy angela shirley anna brenda pamela
  nicole emma samantha katherine christine debra rachel carolyn janet catherine maria heather
  diane ruth julie olivia joyce virginia victoria kelly lauren christina joan evelyn
  judith megan andrea cheryl hannah jacqueline martha gloria teresa ann sara madison frances
  kathryn janice jean abigail alice judy sophia julia marie isabella amber danielle
  chantelle chanel candice bianca caitlin jade kayla lindsay monique natasha shannon tamryn
  clement clive colin cyril desmond dennis derek donovan edward eugene ferdinand frederick
  gavin geoffrey gerald gordon harold henry howard ian ivan jeremy jerome julian kenneth
  lawrence leonard lionel malcolm martin maxwell nigel norman oliver oscar patrick percy
  phillip quentin ralph raymond reginald roger ronald roy rupert russell sidney stanley
  terence timothy vernon victor vincent walter winston
  cyril jacob nelson oliver walter albertina winnie thuli helen
  george arthur alfred albert alan alex alexander allan alistair angus anton antonio
  barry ben benjamin bernard billy blake bradley brendan brett bruce bryan byron calvin
  cameron carl carlos chris christian clinton cody conrad curtis dale damian damien
  danny darren dave denzel devon dirk dominic don donald douglas duane dustin earl
  eddie edwin elias elijah elliot emile eric erik ernest ethan evan ewan felix fred
  gabriel garth gary gene george gerrit gideon glen glenn gordon graeme hans harry
  hector herman hugo isaac jacques jake jared jarred jay jeff jeffrey jesse joel jon
  jonathan jordan josh joshua juan jules karl keegan keenan ken kenny kian kurt lars
  leon leroy lewis louis lucas luis luke marc marco marcus mario marlon martin mason
  matt max michel miguel mike miles mitchell morgan nathaniel nick niel noah noel
  owen pablo patrick paulo pedro philip pierre quinn rafael ray reagan regan reuben
  rex rhys ricardo rick ricky rob robbie robin rodney ronnie ross ruben rudi ruan
  sam samuel scott sebastian seth sheldon shaun sipho stefan steve stephen sven ted
  terry theo theodore tim toby todd tom tommy tony tristan troy tyler ulrich vaughn
  wade werner wesley wian xavier zach zachary zane
  abby adele adri adriana agnes aileen alana alexandra alicia alison allison alma
  althea amelia ana anastasia andile angelique anika anita anja anke annette annika
  antoinette ariana audrey ava bella belinda beth bettie betty beverley brenda bridget
  brittany bronwyn brooke caitlyn camilla carla carmen caroline carolyn cassandra
  cecilia celeste charlene charlotte chloe christelle claire clara claudia colleen
  connie corlia courtney dana daphne debbie delia denise diana dominique doreen
  edith eileen elaine eleanor elize ella ellen eloise elsa elsie emma erica erin
  esme esther eunice eva eve fiona francesca gail gemma georgia gillian gina giselle
  gwen hayley heidi helena hilda holly imogen ina ingrid irene iris isabel isla ivy
  jackie jana janine jasmine jeanette jenna jenny jessie jo joanne jocelyn johanna
  jolene josephine joy juanita julia juliet justine kaylee kate katie kerry kim
  kirsten kirsty klara kristen kristin lara leah leila lena leonie lesley lilian
  lindie lisa liza lize lorraine louise lucy lydia lynette lynn madeleine maggie
  mandy marcelle margot marguerite mariana marilyn marina marisa marissa marlene
  martie maureen melanie melinda melody mia michaela mikayla minette miranda miriam
  molly mona nadine naomi natalie nathalie nerine nina nora odette olga paige
  paula paulette penelope petra philippa phoebe pippa rachel renate renee rhoda
  rita robyn rochelle ronel rosa rosalind rosemary roxanne sabrina sally samantha
  sandy sasha selma shelley sheila shirley sian simone sonia sophie stacey stella
  sue sunette susanna suzanne sylvia tamara tammy tania tarryn tessa thea tiffany
  tina tracey tracy trudy ursula valerie vanessa vera veronica vicky vivian wendy
  yvette yvonne zoe
  `;

  const LAST = `
  nkosi dlamini ndlovu mkhize zulu khumalo ngcobo mthembu sithole mahlangu shabalala zwane
  cele mokoena mokena mokoana molefe mofokeng nkuna maluleke baloyi mabunda chauke mathebula
  hlongwane hadebe gumede buthelezi msimang mbatha ntuli shezi zungu vilakazi xaba majola
  mabaso madonsela masilela maseko mashaba mathe mazibuko mbele mdlalose mhlongo mkhwanazi
  mlambo mnisi motaung motsepe mthethwa mtshali myeni ndaba ndebele ngubane ngwenya nhlapo
  nxumalo radebe sibiya simelane thwala tshabalala twala vezi xulu zondo zuma
  mabuza mabena mahlaba makhubela malatji malema mamabolo mametja manamela maphanga
  maponya mashigo masondo matlala matsane mazibuko mphahlele mokgadi mokwena molapo
  moloi monareng mosia motloung mphuthi nkadimeng phala rammala ramaphosa ramokgopa
  sebola sekgobela selepe seloane setshedi thobejane tlou tshwane tladi
  mbeki mandela sisulu tambo hani biko sobukwe luthuli mokaba mlambo-ngcuka
  ndzimande nzimande gigaba mapisa-nqakula motshekga pandor mantashe
  botha van der merwe smit smith venter du toit pretorius nel botes coetzee fourie
  joubert kruger le roux louw marais mostert naude oosthuizen potgieter rossouw steyn
  swanepoel van wyk van zyl visser vorster badenhorst bezuidenhout blignaut breytenbach
  burger cilliers de beer de klerk de villiers du plessis du preez engelbrecht erasmus
  ferreira geldenhuys grobler hattingh jacobs janse jansen van rensburg jordaan labuschagne
  lombard meyer muller myburgh nieuwoudt olivier pienaar prinsloo retief roux scholtz
  schoeman strydom terblanche theron uys van den berg van niekerk van rooyen viljoen
  vermaak wessels williams
  naidoo pillay govender reddy moodley chetty padayachee singh maharaj naicker moonsamy
  pather perumal ramsamy ramdass sewpersad soobramoney subramoney sukdeo dookhi
  patel desai khan mohamed ebrahim essop jeena kajee mayet moosa omar parker vawda
  adams abrahams april arendse august booysen cupido daniels davids fortuin hendricks
  isaacs jacobs january johnson julies kleinsmidt koopman lakey petersen pietersen
  rogers samuels september solomons stevens titus
  brown jones miller davis wilson anderson taylor thomas moore martin jackson thompson
  white harris clark lewis robinson walker young allen king wright scott green baker
  hall hill campbell mitchell roberts carter phillips evans turner parker collins edwards
  stewart morris murphy cook rogers morgan cooper peterson reed bailey bell kelly howard
  ward cox richardson wood watson brooks bennett gray james hughes price sanders myers
  lange de lange langeveldt la grange lamprecht beukes basson bekker benade bosch boshoff
  brink bruwer claassen conradie cronje dippenaar dreyer du toit eksteen esterhuizen
  ferreira fick gericke gouws greeff haasbroek heyns hugo human jooste kotze kriel
  le grange liebenberg lourens malan maree marx mouton nortje odendaal opperman
  pieterse rautenbach redelinghuys rheeder roets scheepers schutte slabbert snyman
  spies stander steenkamp stoltz strauss truter van aswegen van heerden van tonder
  van vuuren vermeulen vosloo wiese wolmarans zietsman
  abbott ali allison armstrong arnold atkinson austin barker barnes barrett bates
  bishop black blake booth bradley briggs burns burton butler byrne carr chapman
  clarke cole connolly cooke craig crawford cunningham dale dawson day dean dixon
  doyle duncan dunn elliott ellis fleming fletcher ford fox francis fraser fuller
  gardner gibson gilbert gordon grant greene griffiths hale harding hardy harper
  harrison hart harvey hawkins hayes holmes hopkins howell hudson hunt hunter jacobs
  jenkins kennedy kent knight lambert lane lawrence lawson little lloyd lowe mann
  marsh mason matthews mccarthy mcdonald mills moss murray newman nicholson norris
  o'brien obrien oliver o'neill palmer pearce pearson pope porter potter powell
  quinn read reid rhodes rice richards riley robertson rose ryan saunders shaw sharp
  simpson slater spencer stevenson stone summers sutton swift thomson todd tucker
  wade walsh warren watts webb webster wells whitehead wilkinson willis wright
  maseko mashele mabe matlou mokgosi motsoeneng mpofu mudau netshitenzhe nemukula
  ramabulana rasethaba ravele sigudla mulaudzi tshivhase mukhuba
  long ross foster powell jenkins perry russell sullivan fisher henderson coleman simmons
  patterson jordan reynolds hamilton graham wallace woods cole west owens marshall
  `;

  // Common words that are also first names; need a surname or a cue to count.
  const AMBIGUOUS = `
  april may june august grace hope faith joy gift precious blessing patience prudence
  charity mercy beauty lucky smart innocent justice peace happy pearl ruby rose lily
  violet amber jade crystal summer autumn dawn sunny star bill bob will jack frank
  mark grant dean hunter chase drew lance neil rich sky river art guy van
  `;

  const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
  const first = words(FIRST);
  const last = new Set();
  // Multi-word surnames ("van der merwe") are stored as their last word plus the full form.
  for (const raw of LAST.split(/\n/)) {
    for (const w of raw.trim().split(/\s+/).filter(Boolean)) last.add(w);
  }
  const multiWordSurnames = ["van der merwe", "du toit", "le roux", "van wyk", "van zyl", "de beer", "de lange", "la grange", "le grange",
    "de klerk", "de villiers", "du plessis", "du preez", "janse van rensburg", "van den berg",
    "van niekerk", "van rooyen"];
  for (const s of multiWordSurnames) last.add(s);
  // Particles that are part of surnames but not names on their own.
  for (const p of ["van", "der", "du", "de", "le", "den", "janse"]) last.delete(p);

  const api = { first, last, ambiguous: words(AMBIGUOUS), multiWordSurnames };
  root.PG = root.PG || {};
  root.PG.names = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
