"""Voice enrollment: sentences the user reads aloud so Aura can measure (and later fine-tune on) their speech.
Sentences mix everyday phrasing with the technical English words people code-mix, like real questions to Aura."""
from __future__ import annotations

import re
import unicodedata

PROMPTS: dict[str, list[str]] = {
    "te": [
        "నమస్కారం, నా పేరు మీకు తెలుసా?",
        "మెషిన్ లెర్నింగ్ గురించి సులభంగా వివరించండి.",
        "సపోర్ట్ వెక్టర్ మెషిన్ ఎలా పని చేస్తుంది?",
        "లీనియర్ రిగ్రెషన్ మరియు లాజిస్టిక్ రిగ్రెషన్ మధ్య తేడా ఏమిటి?",
        "నాకు పైథాన్ కోడ్ చూపించండి.",
        "ఈ రోజు వాతావరణం ఎలా ఉంది?",
        "ప్రిన్సిపల్ కాంపోనెంట్ అనాలిసిస్ అంటే ఏమిటి?",
        "నా డాక్యుమెంట్స్ ఫోల్డర్ నుండి పీడీఎఫ్ లోడ్ చేయండి.",
        "నా ఇష్టమైన ప్రోగ్రామింగ్ భాష గోలాంగ్ అని గుర్తుంచుకో.",
        "నేను మీకు ఇంతకు ముందు ఏమి చెప్పాను?",
        "కొంచెం మెల్లగా, అర్థమయ్యేలా చెప్పండి.",
        "ఇండియన్ క్రికెట్ టీమ్ కెప్టెన్ ఎవరు?",
        "న్యూరల్ నెట్‌వర్క్ లో లేయర్స్ ఎందుకు ఉంటాయి?",
        "ఓవర్‌ఫిట్టింగ్ ని ఎలా తగ్గించాలి?",
        "ఈ పుస్తకంలో క్లస్టరింగ్ గురించి ఏమి ఉంది?",
        "కే-నియరెస్ట్ నెయిబర్స్ అల్గారిథమ్ ఉదాహరణతో చెప్పండి.",
        "రాండమ్ ఫారెస్ట్ మరియు డెసిషన్ ట్రీ ని పోల్చండి.",
        "దయచేసి సమాధానం తెలుగులో చెప్పండి.",
        "తాజ్ మహల్ ను ఎవరు నిర్మించారు?",
        "ధన్యవాదాలు, చాలా బాగా వివరించారు.",
        # code-mixed, the way it is actually spoken (English terms stay English) — used by evaluation/asr_eval.py
        "నాకు YOLO model training గురించి explain చెయ్యి.",
        "కొంచెం నాకు support vector machine గురించి detail information ఇస్తారా?",
        "ఈ PDF లో gradient descent ఎక్కడ ఉంది?",
        "Python లో list comprehension ఎలా రాయాలి?",
        "నా Downloads folder లో ఉన్న resume ని open చెయ్యకు, just list చెయ్యి.",
        "Transformer model లో attention ఎందుకు important?",
    ],
    "hi": [
        "नमस्ते, क्या आप मेरी आवाज़ साफ़ सुन पा रहे हैं?",
        "मशीन लर्निंग को आसान भाषा में समझाइए।",
        "सपोर्ट वेक्टर मशीन कैसे काम करती है?",
        "लीनियर रिग्रेशन और लॉजिस्टिक रिग्रेशन में क्या अंतर है?",
        "मुझे पाइथन कोड दिखाओ।",
        "प्रिंसिपल कंपोनेंट एनालिसिस क्या होता है?",
        "मेरे डॉक्यूमेंट्स फ़ोल्डर से पीडीएफ लोड करो।",
        "याद रखना कि मेरी पसंदीदा प्रोग्रामिंग भाषा गोलैंग है।",
        "मैंने आपको पहले क्या बताया था?",
        "थोड़ा धीरे और समझा कर बताइए।",
        "न्यूरल नेटवर्क में लेयर्स क्यों होती हैं?",
        "ओवरफिटिंग को कैसे कम करें?",
        "इस किताब में क्लस्टरिंग के बारे में क्या लिखा है?",
        "रैंडम फ़ॉरेस्ट और डिसीजन ट्री की तुलना करो।",
        "भारतीय क्रिकेट टीम का कप्तान कौन है?",
        "कृपया जवाब हिंदी में दीजिए।",
        "ताजमहल किसने बनवाया था?",
        "आज का मौसम कैसा है?",
        "के-नियरेस्ट नेबर्स एल्गोरिथ्म को उदाहरण के साथ समझाओ।",
        "धन्यवाद, आपने बहुत अच्छे से समझाया।",
        "मुझे YOLO model training के बारे में explain करो।",
        "भाई थोड़ा मेरे को support vector machine समझा दो।",
        "इस PDF में gradient descent कहाँ है?",
        "Python में list comprehension कैसे लिखते हैं?",
        "Transformer model में attention क्यों important है?",
        "मेरे Downloads folder की PDF files की list दिखाओ।",
    ],
    "en": [
        "Hello Aura, can you hear me clearly?",
        "Explain machine learning in simple words.",
        "How does a support vector machine work?",
        "What is the difference between linear and logistic regression?",
        "Show me the Python code for k-means clustering.",
        "What is principal component analysis?",
        "Load the PDF from my Documents folder.",
        "Remember that my favourite programming language is Golang.",
        "What did I tell you earlier about my project?",
        "Compare random forests and decision trees.",
        "How do I reduce overfitting in a neural network?",
        "Who is the captain of the Indian cricket test team?",
        "Summarise chapter three of my book.",
        "Explain gradient descent with an example.",
        "Please answer briefly and clearly.",
        "Who built the Taj Mahal?",
        "What does the book say about cross validation?",
        "Give me the steps to install scikit-learn.",
        "What is the weather like today?",
        "Thank you, that was a great explanation.",
    ],
}


def _norm(t: str) -> str:
    t = unicodedata.normalize("NFC", t.lower())
    # drop punctuation/symbols only — vowel signs in Indic scripts are combining marks and must be kept
    t = "".join(" " if unicodedata.category(c)[0] in "PS" else c for c in t)
    return re.sub(r"\s+", " ", t).strip()


def char_accuracy(ref: str, hyp: str) -> float:
    """1 − character error rate (Levenshtein over characters, spaces ignored). Character-level suits Indic scripts."""
    a, b = _norm(ref).replace(" ", ""), _norm(hyp).replace(" ", "")
    if not a:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return max(0.0, 1 - prev[-1] / len(a))
