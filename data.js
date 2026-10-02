/**
 * File: data.js
 * Rest Your Case - Master Data Architecture & Procedural Sampler
 * 
 * Contains all static evidentiary pools, statutory crime rosters,
 * demographic naming pools, FRE misconduct rules, and verdict guides.
 */

const GAME_DATA = {
  // =========================================================================
  // 1. COURTROOM ROSTERS (Bench & Prosecution)
  // =========================================================================
  judges: [
    {
      name: "Judge Arthur Pendelton",
      style: "Textualist / Procedure-Strict",
      temperament: "Pedantic, easily irritated by improper FRE phrasing, impatient with speaking objections.",
      bias_tendency: "Sustains strict technical objections; penalizes speculative defense lines quickly."
    },
    {
      name: "Judge Evelyn Ramos",
      style: "Pragmatic / Docket-Pacing",
      temperament: "Fast-paced, values courtroom efficiency, hates redundant questioning or theatrical pauses.",
      bias_tendency: "Gives latitude to cross-examination as long as it moves rapidly toward a concrete point."
    },
    {
      name: "Judge Kenneth Choi",
      style: "Forensic / Detail-Obsessed",
      temperament: "Analytical, listens intensely to foundation and chain of custody, ignores emotional appeals.",
      bias_tendency: "Highly receptive to suppression motions when technical custody records are flawed."
    },
    {
      name: "Judge Mirah Al-Hassan",
      style: "Constitutionalist / Defense-Fair",
      temperament: "Calm, deliberate, fiercely protective of Brady obligations and 4th/5th Amendment boundaries.",
      bias_tendency: "Holds prosecutors to strict standards on warrantless actions; tolerates aggressive defense inquiry."
    },
    {
      name: "Judge Raymond Callahan",
      style: "Pro-Law-Enforcement / Traditionalist",
      temperament: "Gruff, old-school, skeptical of technical defense motions, values police credibility.",
      bias_tendency: "Issues strikes quickly for defense badgering; skeptical of alternative suspect theories."
    },
    {
      name: "Judge Patricia De La Torre",
      style: "Even-Handed / Academic",
      temperament: "Cerebral, demands precise citations of statutory elements, unmoved by dramatic rhetoric.",
      bias_tendency: "Rules purely on black-letter evidentiary precedent regardless of who objects."
    }
  ],

  district_attorneys: [
    {
      name: "ADA Gregory Thorne",
      style: "Bulldozer / Aggressive",
      temperament: "Relentless, pushes witnesses hard, uses leading questions to trap hesitant defendants.",
      tactic: "Attempts to introduce prejudicial character evidence under FRE 404(b) unless objected to."
    },
    {
      name: "ADA Samantha Ward",
      style: "Forensic Precisionist",
      temperament: "Methodical, quiet, builds circumstantial evidence block-by-block with documents.",
      tactic: "Relies heavily on digital logs and phone records; rarely loses chain of custody."
    },
    {
      name: "ADA Tariq Mansour",
      style: "Charismatic Storyteller",
      temperament: "Smooth, paints vivid emotional narratives for the jury, plays heavily to victim sympathy.",
      tactic: "Skirts around hearsay rules (FRE 802) by framing rumors as excited utterances or context."
    },
    {
      name: "ADA Elena Rostova",
      style: "Cold Realist / Deal-Cutter",
      temperament: "Dispassionate, unyielding, zeroes in on defendant timeline contradictions without mercy.",
      tactic: "Uses cooperating witnesses and plea deals; attacks defendant alibis with cross-checks."
    },
    {
      name: "ADA Marcus Delaney",
      style: "Bureaucratic / By-the-Book",
      temperament: "Cautious, conservative with motions, over-indexes on police officer statements.",
      tactic: "Struggles when confronted with unexpected physical contradictions or suppressed exhibits."
    },
    {
      name: "ADA Chloe Zhang",
      style: "Rapid-Fire Cross-Examiner",
      temperament: "Sharp, sharp-tongued, fires quick compound questions to induce nervous slip-ups.",
      tactic: "Frequently tests judicial boundaries with argumentative questions and assumed unproven facts."
    }
  ],

  // =========================================================================
  // 2. DEMOGRAPHIC NAME POOLS (Clients, Witnesses, Victims)
  // =========================================================================
  names_by_ethnicity: {
    arab: {
      first_names: {
        male: ["Tariq", "Zaid", "Omar", "Youssef", "Hamza", "Kareem", "Bilal", "Mustafa", "Ziyad", "Samir", "Mazen"],
        female: ["Fatima", "Mariam", "Layla", "Amina", "Noor", "Salma", "Huda", "Rania", "Dina", "Lina"]
      },
      last_names: ["Al-Mansoor", "Al-Ghamdi", "El-Sayed", "Al-Harbi", "Kabbani", "Al-Otaibi", "Haddad", "Al-Shehri", "Darwish", "Al-Qahtani", "Nasser", "Al-Zahrani", "Khoury", "Al-Dossari", "Barakat", "Al-Mutairi", "Suleiman", "Barbood", "Najjar", "Al-Subaie"]
    },
    english: {
      first_names: {
        male: ["Liam", "Oliver", "William", "James", "Benjamin", "Lucas", "Henry", "Alexander", "Sebastian", "Owen"],
        female: ["Emma", "Charlotte", "Amelia", "Sophia", "Isabella", "Mia", "Evelyn", "Harper", "Grace", "Abigail", "Alex", "McKenna"]
      },
      last_names: ["Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "White", "Harris", "Clark", "Lewis", "Walker", "Young", "Allen"]
    },
    han: {
      first_names: {
        male: ["Wei", "Jun", "Hao", "Chen", "Bo", "Tao", "Feng", "Ming", "Jian", "Lei"],
        female: ["Fang", "Mei", "Jing", "Yan", "Li", "Hua", "Xia", "Ling", "Qing", "Dan"]
      },
      last_names: ["Wang", "Li", "Zhang", "Liu", "Chen", "Yang", "Huang", "Zhao", "Wu", "Zhou", "Xu", "Sun", "Ma", "Zhu", "Hu", "Guo", "He", "Gao", "Lin", "Luo"]
    },
    bengali: {
      first_names: {
        male: ["Tanvir", "Farhan", "Shakib", "Imtiaz", "Kazi", "Tamim", "Anis", "Zubair"],
        female: ["Nusrat", "Tasnim", "Rumana", "Nabila", "Sadia", "Farzana", "Sharmin"]
      },
      last_names: ["Rahman", "Hossain", "Ahmed", "Islam", "Khan", "Choudhury", "Sarker", "Haque", "Uddin", "Miah", "Siddique", "Bhuiyan", "Dewan", "Talukder", "Majumder"]
    },
    indian: {
      first_names: {
        male: ["Arjun", "Rohan", "Aarav", "Vikram", "Aditya", "Kunal", "Siddharth", "Rahul"],
        female: ["Ananya", "Pooja", "Priya", "Sneha", "Riya", "Kavita", "Isha"]
      },
      last_names: ["Sharma", "Patel", "Verma", "Rao", "Gupta", "Deshmukh", "Mehta", "Iyer", "Nair", "Kulkarni", "Bose", "Chatterjee", "Banerjee", "Mukherjee", "Dutta"]
    },
    japanese: {
      first_names: {
        male: ["Kenji", "Hiroshi", "Daiki", "Ren", "Souta", "Haruto", "Yuto", "Kaito"],
        female: ["Yuki", "Aoi", "Hina", "Yua", "Sakura", "Sora", "Asahi"]
      },
      last_names: ["Sato", "Suzuki", "Takahashi", "Tanaka", "Watanabe", "Ito", "Yamamoto", "Nakamura", "Kobayashi", "Kato", "Yoshida", "Yamada", "Sasaki", "Yamaguchi", "Saito"]
    },
    korean: {
      first_names: {
        male: ["Min-jun", "Do-yoon", "Ye-jun", "Si-woo", "Ju-won", "Hyun-woo", "Ji-ho", "Min-seo"],
        female: ["Seo-yeon", "Ha-eun", "Ji-woo", "Su-a", "Chae-won", "Eun-ji", "So-eun"]
      },
      last_names: ["Kim", "Lee", "Park", "Choi", "Jeong", "Kang", "Cho", "Yoon", "Jang", "Lim", "Han", "Oh", "Seo", "Shin", "Kwon"]
    },
    west_african: {
      first_names: {
        male: ["Kofi", "Kwame", "Chidi", "Emeka", "Babajide", "Oluwaseun", "Adewale", "Abubakar"],
        female: ["Ama", "Akua", "Ngozi", "Chioma", "Folake", "Zainab", "Fatoumata"]
      },
      last_names: ["Mensah", "Osei", "Appiah", "Boateng", "Okafor", "Adeyemi", "Balogun", "Nwosu", "Eze", "Diallo", "Traore", "Camara", "Sow", "Diop", "Cisse"]
    },
    hispanic: {
      first_names: {
        male: ["Mateo", "Santiago", "Alejandro", "Diego", "Carlos", "Joaquin", "Andres", "Gabriel"],
        female: ["Valentina", "Camila", "Lucia", "Elena", "Mariana", "Sofia", "Isabela"]
      },
      last_names: ["Rodriguez", "Hernandez", "Lopez", "Gonzalez", "Martinez", "Garcia", "Morales", "Castillo", "Vargas", "Reyes", "Gutierrez", "Navarro", "Torres", "Mendoza", "Romero"]
    }
  },

  // =========================================================================
  // 3. STATUTORY CRIME GENRES & CHARGES
  // =========================================================================
  crime_genres: {
    violent_crimes: {
      genre: "Violent Crimes",
      charges: [
        {
          charge: "First-Degree Murder",
          statutory_definition: "Unlawful killing of a human being with malice aforethought and premeditation.",
          mens_rea: "Specific intent / Premeditated malice",
          core_elements: [
            "Intentional killing of a human being",
            "Actual reflection and advance planning (premeditation)",
            "Deliberate execution without lawful justification"
          ],
          complexity_range: [4, 5]
        },
        {
          charge: "Second-Degree Murder",
          statutory_definition: "Unlawful killing of a human being with malice but lacking advance premeditation or deliberation.",
          mens_rea: "Malice aforethought / Depraved heart (extreme indifference to human life)",
          core_elements: [
            "Intentional infliction of lethal bodily harm without advance planning, OR",
            "Conduct demonstrating conscious disregard for imminent risk of death"
          ],
          complexity_range: [3, 5]
        },
        {
          charge: "Aggravated Assault with a Deadly Weapon",
          statutory_definition: "Intentionally placing another in imminent apprehension of serious bodily injury using a lethal instrument.",
          mens_rea: "General intent / Purposeful apprehension",
          core_elements: [
            "Act causing immediate reasonable fear of severe physical injury",
            "Use, display, or employment of a firearm, blade, or blunt instrument capable of causing death"
          ],
          complexity_range: [1, 3]
        },
        {
          charge: "Armed Robbery",
          statutory_definition: "Unlawful taking of personal property from the immediate presence of another through force or threat, while carrying a weapon.",
          mens_rea: "Specific intent to permanently deprive",
          core_elements: [
            "Felonious taking and asportation of property",
            "Execution via physical coercion, intimidation, or direct violence",
            "Brandishing or possession of a dangerous weapon during the act"
          ],
          complexity_range: [2, 4]
        },
        {
          charge: "Kidnapping / False Imprisonment",
          statutory_definition: "Unlawful seizure, confinement, or substantial movement of a non-consenting person through threat or violence.",
          mens_rea: "Knowing and willful restraint",
          core_elements: [
            "Substantial movement (asportation) or prolonged non-consensual confinement",
            "Deprivation of personal liberty by force, fear, or fraud"
          ],
          complexity_range: [3, 5]
        },
        {
          charge: "Aggravated Battery Causing Great Bodily Harm",
          statutory_definition: "Unlawful and intentional physical contact resulting in permanent disability, disfigurement, or substantial organ damage.",
          mens_rea: "Specific intent to cause severe injury",
          core_elements: [
            "Actual non-consensual physical contact",
            "Infliction of severe, permanent, or life-threatening anatomical damage"
          ],
          complexity_range: [1, 3]
        },
        {
          charge: "Attempted Murder",
          statutory_definition: "Taking a direct, unequivocal step toward committing an unlawful killing accompanied by the specific intent to kill.",
          mens_rea: "Explicit specific intent to cause death",
          core_elements: [
            "Direct overt act beyond mere preparation",
            "Direct intention that the target perish, frustrated by external intervention"
          ],
          complexity_range: [3, 5]
        }
      ]
    },
    financial_fraud: {
      genre: "Financial Fraud & White-Collar Crimes",
      charges: [
        {
          charge: "Wire Fraud (18 U.S.C. § 1343)",
          statutory_definition: "Devising or intending to devise a scheme to defraud or obtain property by materially false pretenses using interstate electronic communications.",
          mens_rea: "Specific intent to defraud",
          core_elements: [
            "Participation in an intentional scheme or artifice to defraud",
            "Materially false statements, representations, or omissions",
            "Use of interstate wire, banking, or telecommunications networks in furtherance of the scheme"
          ],
          complexity_range: [2, 4]
        },
        {
          charge: "Securities Fraud / Insider Trading",
          statutory_definition: "Employing deceptive devices or trading on material, non-public information in breach of a fiduciary duty in connection with the purchase or sale of securities.",
          mens_rea: "Scienter (knowledge of deception or reckless disregard for truth)",
          core_elements: [
            "Misrepresentation or trading based on material non-public information",
            "Breach of a duty of trust or confidence owed to shareholders or source",
            "Direct nexus to the purchase, sale, or valuation of securities"
          ],
          complexity_range: [4, 5]
        },
        {
          charge: "Embezzlement & Corporate Misappropriation",
          statutory_definition: "Fraudulent conversion of funds or property lawfully entrusted to an agent, executive, or fiduciary for their own unauthorized use.",
          mens_rea: "Specific intent to permanently convert or misappropriate",
          core_elements: [
            "Lawful initial custody of property by virtue of fiduciary trust or corporate role",
            "Fraudulent conversion or unauthorized transfer of assets to personal/shell accounts"
          ],
          complexity_range: [3, 5]
        }
      ]
    },
    cyber_crime: {
      genre: "Cybercrime & Digital Intrusion",
      charges: [
        {
          charge: "Unauthorized Computer Access (CFAA - 18 U.S.C. § 1030)",
          statutory_definition: "Intentionally accessing a protected computer system without authorization or exceeding authorized access to obtain sensitive information.",
          mens_rea: "Knowing and intentional unauthorized intrusion",
          core_elements: [
            "Interstate or protected computer network accessed",
            "Absence of valid credentials or explicit circumvention of security controls",
            "Acquisition, exfiltration, or viewing of restricted financial or proprietary data"
          ],
          complexity_range: [2, 4]
        },
        {
          charge: "Digital Extortion & Ransomware Deployment",
          statutory_definition: "Transmitting threats to impair, lock, or release confidential data from a protected network with the intent to extort money or assets.",
          mens_rea: "Specific intent to extort",
          core_elements: [
            "Deployment of malicious payloads or unauthorized cryptographic locks",
            "Communication of an explicit demand for value under threat of destruction or leak"
          ],
          complexity_range: [4, 5]
        },
        {
          charge: "Aggravated Identity Theft (18 U.S.C. § 1028A)",
          statutory_definition: "Knowingly transferring, possessing, or using a means of identification of another person without lawful authority during and in relation to a felony.",
          mens_rea: "Knowledge that the identification belonged to an actual person",
          core_elements: [
            "Unauthorized possession or deployment of unique identifying credentials (SSN, API keys, private keys)",
            "Direct nexus to an underlying felony offense (such as wire fraud or illicit wire transfers)"
          ],
          complexity_range: [3, 4]
        },
        {
          charge: "Trade Secret Theft & Corporate Espionage",
          statutory_definition: "Stealing, duplicating, or downloading proprietary trade secrets with the intent or knowledge that it will injure the owner.",
          mens_rea: "Knowing theft with intent to convert to economic benefit",
          core_elements: [
            "Subject data qualifies as a protected proprietary trade secret",
            "Unauthorized exfiltration, remote copying, or transmission to third parties or competitor systems"
          ],
          complexity_range: [4, 5]
        }
      ]
    },
    substance_use_and_distribution: {
      genre: "Substance Use, Trafficking & Controlled Substances",
      charges: [
        {
          charge: "Possession with Intent to Distribute (PWID)",
          statutory_definition: "Knowingly exercising dominion and control over a controlled substance with the purpose of unlawful sale, transfer, or dispersal.",
          mens_rea: "Knowing possession with specific intent to distribute",
          core_elements: [
            "Direct or constructive custody of a schedule-classified narcotic",
            "Quantity, packaging (baggies, scales), or ledger documentation indicating intent to sell rather than personal use"
          ],
          complexity_range: [2, 4]
        },
        {
          charge: "Conspiracy to Traffic Narcotics (21 U.S.C. § 846)",
          statutory_definition: "Entering into an agreement between two or more parties to commit controlled substance trafficking, accompanied by an overt act.",
          mens_rea: "Knowing and voluntary joinder in the unlawful objective",
          core_elements: [
            "Mutual agreement to distribute bulk narcotics across jurisdictional lines",
            "Defendant's knowing participation in logistics, funding, transport, or supply"
          ],
          complexity_range: [4, 5]
        },
        {
          charge: "Operating a Drug-Involved Premises",
          statutory_definition: "Knowingly maintaining, renting, managing, or controlling any building or room for the purpose of manufacturing or distributing controlled substances.",
          mens_rea: "Knowing and willful maintenance of premises",
          core_elements: [
            "Legal control, leasehold, or managerial dominion over the real property",
            "Substantial continuing purpose of the premises dedicated to illicit narcotics operations"
          ],
          complexity_range: [2, 4]
        },
        {
          charge: "Illicit Pharmaceutical & Precursor Diversion",
          statutory_definition: "Fraudulently obtaining, diverting, or distributing controlled prescription pharmaceuticals or regulated precursor chemicals.",
          mens_rea: "Knowing and fraudulent acquisition or diversion",
          core_elements: [
            "Fabricated prescriptions, compromised DEA license numbers, or inventory diversion",
            "Redirection of regulated substances into the black market"
          ],
          complexity_range: [3, 5]
        },
        {
          charge: "Simple Felony Possession",
          statutory_definition: "Knowingly possessing an illicit schedule narcotic in an amount exceeding statutory misdemeanor thresholds without valid medical authorization.",
          mens_rea: "Knowing dominion and control",
          core_elements: [
            "Direct physical or constructive possession of the illicit substance",
            "Chemical forensic identification confirming schedule qualification and statutory weight"
          ],
          complexity_range: [1, 2]
        }
      ]
    },
    overcharge_and_manslaughter: {
      genre: "Overcharge Scenarios & Manslaughter",
      charges: [
        {
          charge: "Voluntary Manslaughter (Heat of Passion / Imperfect Self-Defense)",
          statutory_definition: "An intentional killing committed under sudden heat of passion caused by adequate provocation, or an honest but unreasonable belief in the need for deadly force.",
          mens_rea: "Intentional killing mitigated by adequate provocation",
          core_elements: [
            "Intentional application of lethal force",
            "Action provoked by circumstances sufficient to arouse intense passion in a reasonable person",
            "Absence of sufficient cooling-off time, or honest but objectively flawed defensive belief"
          ],
          complexity_range: [3, 5]
        },
        {
          charge: "Involuntary Manslaughter / Gross Criminal Negligence",
          statutory_definition: "An unintentional killing resulting from recklessness or criminal negligence during lawful acts or non-felony unlawful acts.",
          mens_rea: "Criminal negligence / Reckless disregard for life",
          core_elements: [
            "Death caused directly by the defendant's acts or omissions",
            "Conduct demonstrating gross deviation from reasonable standards of care without intent to kill"
          ],
          complexity_range: [1, 3]
        },
        {
          charge: "Vehicular Manslaughter with Gross Negligence",
          statutory_definition: "Causing the death of another while operating a motor vehicle in a grossly negligent manner or while impaired.",
          mens_rea: "Gross vehicular negligence / Recklessness",
          core_elements: [
            "Operation of a motor vehicle in violation of safety codes or while intoxicated",
            "Direct causal chain connecting defendant's driving to the victim's fatal trauma"
          ],
          complexity_range: [2, 4]
        },
        {
          charge: "Prosecutorial Overcharge: Felony Murder Elevation",
          statutory_definition: "Charging a marginal co-participant with first-degree murder for an unanticipated death occurring during an underlying felony, despite minimal direct involvement.",
          mens_rea: "Intent to commit predicate felony (often heavily disputed at trial)",
          core_elements: [
            "Commission of, or attempt to commit, an enumerated predicate felony",
            "A death occurs during the chain of events",
            "Prosecution attributes full murder culpability to a low-level accomplice or getaway driver"
          ],
          complexity_range: [4, 5]
        },
        {
          charge: "Reckless Endangerment Resulting in Death",
          statutory_definition: "Engaging in conduct creating a substantial and unjustifiable risk of death or serious physical injury, which culminates in a fatality.",
          mens_rea: "Conscious awareness and unjustifiable disregard of substantial risk",
          core_elements: [
            "Creation of an extreme, unjustified hazard to human life",
            "Conscious disregard of that hazard directly resulting in an unintended fatality"
          ],
          complexity_range: [1, 3]
        }
      ]
    }
  },

  // =========================================================================
  // 4. SUB-IDEAS (Venues, Evidence Anchors, Legal Flaws, Frictions, Complications)
  // =========================================================================
  venues: [
    { id: "V01", name: "All-Night Bodega & Fuel Plaza", category: "Commercial Retail", complexity_range: [1, 2] },
    { id: "V02", name: "Suburban Strip Mall Parking Lot", category: "Open Commercial", complexity_range: [1, 2] },
    { id: "V03", name: "Commercial Kitchen & Dish Pit", category: "Food Service & Hospitality", complexity_range: [1, 3] },
    { id: "V04", name: "Independent Auto Repair Bay", category: "Light Industrial", complexity_range: [2, 3] },
    { id: "V05", name: "Self-Storage Facility & Garage Bays", category: "Commercial Storage", complexity_range: [2, 4] },
    { id: "V06", name: "Municipal Transit Maintenance Yard", category: "Civil Infrastructure", complexity_range: [2, 4] },
    { id: "V07", name: "24-Hour Urgent Care & Pharmacy Storage", category: "Healthcare & Pharmaceuticals", complexity_range: [3, 5] },
    { id: "V08", name: "Scrap Metal & Vehicle Recycling Yard", category: "Heavy Industrial", complexity_range: [3, 5] },
    { id: "V09", name: "Intermodal Freight & Container Terminal", category: "Logistics & Maritime", complexity_range: [4, 5] },
    { id: "V10", name: "Commercial Banking Regional Clearinghouse", category: "Corporate & Financial", complexity_range: [4, 5] },
    { id: "V11", name: "Colocation Data Center & Server Farm", category: "Digital Infrastructure", complexity_range: [4, 5] }
  ],

  evidence_anchors: [
    { id: "EA01", item: "Discarded Heavy Work Glove", type: "Physical", complexity_range: [1, 2] },
    { id: "EA02", item: "Point-of-Sale Register Receipt", type: "Documentary", complexity_range: [1, 2] },
    { id: "EA03", item: "Low-Resolution Forecourt CCTV Snippet", type: "Digital", complexity_range: [1, 3] },
    { id: "EA04", item: "Serrated Utility Box Cutter", type: "Physical", complexity_range: [1, 3] },
    { id: "EA05", item: "Handwritten Shift Manifest & Notes", type: "Documentary", complexity_range: [2, 3] },
    { id: "EA06", item: "Equipment Maintenance Sign-Off Card", type: "Documentary", complexity_range: [2, 4] },
    { id: "EA07", item: "Transit Badge Keycard Scan Log", type: "Digital", complexity_range: [2, 4] },
    { id: "EA08", item: "Patrol Dashcam Pre-Event Buffer Clip", type: "Digital", complexity_range: [2, 4] },
    { id: "EA09", item: "Field Presumptive Chemical Test Vial", type: "Forensic", complexity_range: [2, 4] },
    { id: "EA10", item: "Intermodal Bolt Seal Manifest", type: "Documentary", complexity_range: [3, 5] },
    { id: "EA11", item: "Hospital Emergency Toxicology Panel", type: "Forensic", complexity_range: [3, 5] },
    { id: "EA12", item: "Autopsy Anatomical Wound Schematic", type: "Forensic", complexity_range: [3, 5] },
    { id: "EA13", item: "Extracted Encrypted Messaging Log", type: "Digital", complexity_range: [3, 5] },
    { id: "EA14", item: "Remote Server Bastion Auth Log", type: "Digital", complexity_range: [4, 5] },
    { id: "EA15", item: "Laboratory Gas Chromatograph Calibration Readout", type: "Forensic", complexity_range: [4, 5] },
    { id: "EA16", item: "Automated Clearinghouse Wire Trace", type: "Documentary", complexity_range: [4, 5] }
  ],

  legal_flaws: [
    { id: "LF01", flaw: "Uncorroborated Anonymous Tip", legal_basis: "4th Amendment / Reasonable Suspicion", complexity_range: [1, 2] },
    { id: "LF02", flaw: "Showup / Suggestive Identification", legal_basis: "Due Process / Lineup Bias", complexity_range: [1, 3] },
    { id: "LF03", flaw: "Disputed Consent to Search", legal_basis: "4th Amendment / Voluntariness", complexity_range: [2, 4] },
    { id: "LF04", flaw: "Search Exceeding Warrant Scope", legal_basis: "4th Amendment / Particularity Clause", complexity_range: [2, 4] },
    { id: "LF05", flaw: "Unbroken Chain of Custody Gap", legal_basis: "FRE 901 / Evidence Integrity", complexity_range: [2, 4] },
    { id: "LF06", flaw: "Custodial Interrogation Post-Invocation", legal_basis: "5th Amendment / Miranda Violation", complexity_range: [3, 5] },
    { id: "LF07", flaw: "Undisclosed Impeachment Agreement", legal_basis: "Due Process / Brady Violation", complexity_range: [3, 5] },
    { id: "LF08", flaw: "Unreliable Scientific Methodology", legal_basis: "FRE 702 / Daubert Challenge", complexity_range: [4, 5] }
  ],

  witness_frictions: [
    { id: "WF01", friction: "Sensory / Environmental Impairment", complexity_range: [1, 3] },
    { id: "WF02", friction: "Personal Grudge / Prior Feud", complexity_range: [1, 3] },
    { id: "WF03", friction: "Financial Self-Preservation", complexity_range: [2, 4] },
    { id: "WF04", friction: "Shifting Story / Prior Inconsistent Statement", complexity_range: [2, 4] },
    { id: "WF05", friction: "Cooperating Co-Defendant / Plea Deal", complexity_range: [3, 5] },
    { id: "WF06", friction: "Career / Professional Exposure", complexity_range: [3, 5] }
  ],

  client_complications: [
    { id: "CC01", complication: "Fled Due to Active Unrelated Warrant", complexity_range: [1, 2] },
    { id: "CC02", complication: "Protecting a Third Party", complexity_range: [2, 4] },
    { id: "CC03", complication: "Parallel Uncharged Illicit Act", complexity_range: [3, 4] },
    { id: "CC04", complication: "Destruction of Evidence for Unrelated Reason", complexity_range: [3, 5] },
    { id: "CC05", complication: "Prior Felony Disenfranchisement / Paranoia", complexity_range: [4, 5] }
  ],

  // =========================================================================
  // 5. DA PROSECUTORIAL MISCONDUCT (FRE Traps)
  // =========================================================================
  da_misconduct: [
    {
      id: "MC01",
      name: "FRE 404(b) Propensity Ambush",
      legal_basis: "FRE 404(b) / Impermissible Character & Prior Bad Acts",
      tactic_summary: "Eliciting testimony or asking questions referencing uncharged prior arrests, bad reputation, or unrelated misbehavior to bias the jury without prior judicial notice.",
      ai_trigger_instruction: "During direct examination of a witness or cross-examination of the client, introduce an insinuation regarding defendant's past uncharged misdeeds or character flaws.",
      proper_defense_objection: "FRE 404(b) / Impermissible Propensity Evidence",
      complexity_range: [3, 5]
    },
    {
      id: "MC02",
      name: "FRE 611(a) Fact Assumption & Compound Trap",
      legal_basis: "FRE 611(a) / Argumentative & Assuming Facts Not in Evidence",
      tactic_summary: "Embedding unproven material facts inside multi-part questions or demanding yes/no answers to loaded assertions ('When you abandoned the weapon, did you...').",
      ai_trigger_instruction: "Pose a rapid compound question to the witness that treats an unproven core prosecution contention as established fact.",
      proper_defense_objection: "FRE 611 / Assuming Facts Not in Evidence",
      complexity_range: [3, 5]
    },
    {
      id: "MC03",
      name: "FRE 701 Lay Opinion Usurpation",
      legal_basis: "FRE 701 & FRE 702 / Speculative Lay Opinion on Guilt/State of Mind",
      tactic_summary: "Coaxing a non-expert lay witness (patrol cop, neighbor, shift manager) into giving conclusive forensic, ballistics, or psychological intent conclusions.",
      ai_trigger_instruction: "Ask a standard lay witness to evaluate whether the defendant acted with deliberate premeditation, malice, or expert technical intent.",
      proper_defense_objection: "FRE 701 / Improper Lay Opinion / Speculation",
      complexity_range: [4, 5]
    },
    {
      id: "MC04",
      name: "Brady Material Skirting & Concealed Benefit",
      legal_basis: "Due Process / Giglio v. United States / Concealed Witness Inducement",
      tactic_summary: "Eliciting star witness testimony while brushing past or obscuring their non-prosecution proffer, reduced sentencing deal, or cash informant stipend.",
      ai_trigger_instruction: "Frame the cooperating witness as a purely moral, self-directed citizen who stepped forward voluntarily, omitting the state concession.",
      proper_defense_objection: "Motion for Immediate Proffer Disclosure / Impeachment on Concealed Consideration",
      complexity_range: [4, 5]
    },
    {
      id: "MC05",
      name: "FRE 802 Backdoor Hearsay via Police Course-of-Investigation",
      legal_basis: "FRE 802 / Crawford v. Washington / Sixth Amendment Confrontation",
      tactic_summary: "Allowing an investigator to recite out-of-court testimonial statements of an uncalled informant under the guise of explaining 'why the officer took the next investigative step.'",
      ai_trigger_instruction: "Have the lead detective testify about specific assertions made by an unnamed bystander or tipster who is not testifying at trial.",
      proper_defense_objection: "FRE 802 / Confrontation Clause / Testimonial Hearsay",
      complexity_range: [4, 5]
    }
  ],

  // =========================================================================
  // 6. INVESTIGATIVE ARCHETYPES & JURY VERDICT GUIDES
  // =========================================================================
  investigative_archetypes: [
    { id: "IA01", action: "Subpoena Telemetry & Pings", ap: 1, scope: "Tower timing dumps, device offsets, carrier pings", range: [1, 5] },
    { id: "IA02", action: "Subpoena Dispatch & Audio Buffers", ap: 1, scope: "911 call audio, CAD run logs, radio traffic", range: [1, 3] },
    { id: "IA03", action: "Subpoena Transit & Access Telemetry", ap: 1, scope: "Turnstile taps, toll gantries, badge reader logs", range: [2, 4] },
    { id: "IA04", action: "Subpoena Institutional & Intake Logs", ap: 1, scope: "EMS vitals, ED triage notes, shift sign-ins", range: [3, 5] },
    { id: "IA05", action: "Canvass Route & Shift Bystanders", ap: 2, scope: "Graveyard clerks, delivery couriers, night porters", range: [1, 3] },
    { id: "IA06", action: "Canvass Private Optical Sensors", ap: 2, scope: "Residential doorbells, commercial NVRs, dashcams", range: [1, 4] },
    { id: "IA07", action: "Forensic Biological / Ballistics Audit", ap: 2, scope: "Striation matches, tissue margins, DNA mixtures", range: [2, 5] },
    { id: "IA08", action: "Forensic Digital / Instrument Audit", ap: 2, scope: "Drive block hashes, baseline GC-MS drift, auth logs", range: [3, 5] }
  ],

  jury_verdict_guides: {
    violent_crimes: {
      pivot: "Identity & First Aggressor",
      acquittal_test: "Reasonable doubt on physical presence, misidentification, or justified defensive response."
    },
    financial_fraud: {
      pivot: "Scienter & Supervisory Color",
      acquittal_test: "Absence of specific fraudulent intent, reliance on counsel/boss, or good-faith bookkeeping defect."
    },
    cyber_crime: {
      pivot: "Attribution & Environmental Integrity",
      acquittal_test: "Compromised subnet perimeter, lack of proof tying defendant fingers to physical keys, or hash mismatch."
    },
    substance_use_and_distribution: {
      pivot: "Dominion & Purpose Threshold",
      acquittal_test: "Shared vehicular/living premises defeating exclusive control, or quantities strictly consistent with personal habit."
    },
    overcharge_and_manslaughter: {
      pivot: "Malice Negation & Provocation",
      acquittal_test: "Absence of deliberate premeditation, heat of passion with zero cool-down period, or honest defensive belief."
    }
  }
};

// =========================================================================
// RUNTIME SAMPLER FUNCTION
// =========================================================================

/**
 * Procedurally samples 1 seed per category matching the active complexity and category
 * @param {number} complexity - Level 1 to 5
 * @param {string} categoryKey - 'Violent Felony', 'White-Collar Fraud', 'Cybercrime / Espionage', or 'Random Case File'
 * @returns {object} Procedural case docket ready for Turn 1 injection
 */
function sampleCaseDocket(complexity = 3, categoryKey = "Random Case File") {
  const comp = Math.min(5, Math.max(1, parseInt(complexity, 10) || 3));

  // Helper to filter an array by [min, max] complexity range
  function filterByComplexity(arr, key = "complexity_range") {
    const valid = arr.filter(item => {
      const range = item[key] || item.range || [1, 5];
      return comp >= range[0] && comp <= range[1];
    });
    return valid.length > 0 ? valid : arr; // Fallback to all if none in exact range
  }

  // Helper to pick 1 random element from an array
  function pickRandom(arr) {
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // 1. Resolve Crime Category Key to Internal Genre Key
  let genreKey = "violent_crimes";
  const catNormalized = String(categoryKey).toLowerCase();

  if (catNormalized.includes("white-collar") || catNormalized.includes("fraud")) {
    genreKey = "financial_fraud";
  } else if (catNormalized.includes("cyber") || catNormalized.includes("espionage")) {
    genreKey = "cyber_crime";
  } else if (catNormalized.includes("substance") || catNormalized.includes("narcotics")) {
    genreKey = "substance_use_and_distribution";
  } else if (catNormalized.includes("overcharge") || catNormalized.includes("manslaughter")) {
    genreKey = "overcharge_and_manslaughter";
  } else if (catNormalized.includes("random")) {
    const allGenreKeys = Object.keys(GAME_DATA.crime_genres);
    genreKey = pickRandom(allGenreKeys);
  }

  const selectedGenre = GAME_DATA.crime_genres[genreKey];
  const eligibleCharges = filterByComplexity(selectedGenre.charges);
  const pickedCharge = pickRandom(eligibleCharges);

  // 2. Sample Courtroom Roster
  const pickedJudge = pickRandom(GAME_DATA.judges);
  const pickedDA = pickRandom(GAME_DATA.district_attorneys);

  // 3. Sample Demographic Pool to generate a client name
  const ethnicityKeys = Object.keys(GAME_DATA.names_by_ethnicity);
  const chosenEthnicity = pickRandom(ethnicityKeys);
  const ethPool = GAME_DATA.names_by_ethnicity[chosenEthnicity];
  const isFemale = Math.random() > 0.5;
  const firstName = isFemale ? pickRandom(ethPool.first_names.female) : pickRandom(ethPool.first_names.male);
  const lastName = pickRandom(ethPool.last_names);
  const clientName = `${firstName} ${lastName}`;

  // 4. Sample Narrative & Evidentiary Seeds
  const pickedVenue = pickRandom(filterByComplexity(GAME_DATA.venues));
  const pickedAnchor = pickRandom(filterByComplexity(GAME_DATA.evidence_anchors));
  const pickedLegalFlaw = pickRandom(filterByComplexity(GAME_DATA.legal_flaws));
  const pickedWitnessFriction = pickRandom(filterByComplexity(GAME_DATA.witness_frictions));
  const pickedClientComplication = pickRandom(filterByComplexity(GAME_DATA.client_complications));

  // 5. Sample DA Misconduct Trigger & Verdict Guide
  const eligibleMisconduct = filterByComplexity(GAME_DATA.da_misconduct);
  const pickedMisconduct = pickRandom(eligibleMisconduct);
  const verdictGuide = GAME_DATA.jury_verdict_guides[genreKey];

  return {
    meta: {
      complexity: comp,
      genre_key: genreKey,
      genre_name: selectedGenre.genre
    },
    roster: {
      judge: pickedJudge,
      da: pickedDA,
      client: {
        name: clientName,
        ethnicity: chosenEthnicity
      },
      investigator: "Investigator Carlos Diaz"
    },
    charge: pickedCharge,
    narrative_seeds: {
      venue: pickedVenue,
      primary_evidence_anchor: pickedAnchor,
      constitutional_flaw: pickedLegalFlaw,
      witness_friction: pickedWitnessFriction,
      client_complication: pickedClientComplication
    },
    mechanics: {
      da_misconduct_trap: pickedMisconduct,
      jury_verdict_guide: verdictGuide
    }
  };
}

// Export for ES modules / Browser global availability
if (typeof module !== "undefined" && module.exports) {
  module.exports = { GAME_DATA, sampleCaseDocket };
}
