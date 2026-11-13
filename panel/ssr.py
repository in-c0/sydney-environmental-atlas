# SSR scoring (arXiv:2510.08338): embed each free-text response and 5 Likert anchors, cosine similarity,
# subtract the minimum, normalise to a distribution over 1-5; average over paraphrased anchor sets.
#   python3 panel/ssr.py panel/r1.txt [panel/r2.txt ...]     lines: persona|model|question|text
import sys, numpy as np
from collections import defaultdict
from fastembed import TextEmbedding
M = TextEmbedding('BAAI/bge-small-en-v1.5')
emb = lambda t: np.array(list(M.embed(t)))
ANCH = {
 'use': [["I would leave straight away; this is no use to me.", "I would look briefly and then leave; it is not much use to me.", "I might look around a little; I am unsure it is useful.", "I would keep using this for a while; it is useful to me.", "I would definitely keep using this and come back to it."],
         ["I am closing this page now.", "I will poke around for a moment but I won't rely on it.", "It is okay; I may or may not use it.", "I will keep walking around and use it to compare homes.", "This is exactly what I needed and I will use it a lot."],
         ["This is useless to me.", "This is not really for me.", "This is somewhat interesting.", "This is helpful and I will keep going.", "This is extremely helpful and I will keep going."],
         ["I would not spend any time on this.", "I would spend very little time on this.", "I might spend some time on this.", "I would spend a fair amount of time on this.", "I would spend a lot of time on this."]],
 'claim': [["I would definitely not claim it.", "I would probably not claim it.", "I am not sure whether I would claim it.", "I would probably claim it.", "I would definitely claim it right away."],
           ["I refuse to claim this and want it taken down.", "I would rather not claim this.", "I might claim this later.", "I would likely claim this.", "I am claiming this immediately."],
           ["Claiming this is out of the question.", "Claiming this does not appeal to me.", "I am undecided about claiming this.", "Claiming this makes sense for us.", "Claiming this is an obvious yes."],
           ["I will not sign up for this.", "I doubt I will sign up for this.", "I may sign up for this.", "I expect to sign up for this.", "I will sign up for this now."]],
 'vote': [["I would definitely not tap the vote button.", "I would probably not tap the vote button.", "I am not sure whether I would tap the vote button.", "I would probably tap the vote button.", "I would definitely tap the vote button."],
          ["No, I don't tap it and I close the card.", "I doubt I would tap it.", "I might tap it, I might not.", "Yes, I'd probably tap it since it is free.", "Yes, I tap it straight away."],
          ["Voting here is out of the question for me.", "Voting here does not appeal to me.", "I am undecided about voting.", "Voting here seems harmless, so I would.", "Voting here is an easy yes."],
          ["I refuse to vote for this home.", "I would rather not vote for this home.", "I may or may not vote for this home.", "I would vote for this home.", "I vote for this home without hesitation."]],
 'pay': [["I would definitely not pay for this.", "I would probably not pay for this.", "I am not sure whether I would pay for this.", "I would probably pay for this.", "I would definitely pay for this."],
         ["There is no way I am spending money on this.", "I doubt I would spend money on this.", "I might spend money on this, it depends.", "I am fairly likely to spend money on this.", "I will certainly spend money on this."],
         ["Paying for this is out of the question.", "Paying for this does not appeal to me.", "I am undecided about paying for this.", "Paying for this seems worthwhile.", "Paying for this is an easy yes."],
         ["I will never buy this.", "I am unlikely to buy this.", "I may or may not buy this.", "I am likely to buy this.", "I will buy this."]],
}
A = {k: [emb(s) for s in sets] for k, sets in ANCH.items()}
def dist(vec, key):
    out = np.zeros(5)
    for a in A[key]:
        s = a @ vec / (np.linalg.norm(a, axis=1) * np.linalg.norm(vec)); s = s - s.min(); out += s / s.sum()
    return out / len(A[key])
group = lambda p: {'S': 'seeker', 'B': 'builder', 'O': 'outside'}[p[0]]
for path in sys.argv[1:]:
    rows = [l.rstrip('\n').split('|', 3) for l in open(path) if l.strip()]
    V = emb([r[3] for r in rows]); agg = defaultdict(lambda: np.zeros(5)); n = defaultdict(int); per = {}
    for (p, m, q, _), v in zip(rows, V):
        key = 'vote' if q == 'V' else 'pay' if q == 'B' else ('claim' if p[0] == 'B' else 'use'); d = dist(v, key)
        per[(p, m, q)] = d @ np.arange(1, 6)
        for k in [(key, 'all', m), (key, group(p), m), (key, group(p), 'both'), (key, 'all', 'both')]: agg[k] += d; n[k] += 1
    print(f'== {path}')
    for k in sorted(agg):
        d = agg[k] / n[k]; print(f'{k[0]:5} {k[1]:8} {k[2]:6} n={n[k]:2}  ' + ' '.join(f'{x:.2f}' for x in d) + f'  mean {d @ np.arange(1, 6):.2f}')
    print('per persona (mean of distribution): ' + '  '.join(f'{p}{q}/{m[0]}={v:.2f}' for (p, m, q), v in sorted(per.items())))
