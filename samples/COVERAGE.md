# 覆盖度

由 `node src/cli.mjs coverage --out samples/batch2,samples/batch3,samples/batch4,samples/batch5,samples/prompted` 生成。⚠ 表示少于 15 个样本，该格子的指标只看数字、不下结论。

```
视频 254，错误实例 348（⚠ 表示少于 15）
应拦截 / 不应拦截：不应拦截 51，应拦截 203
用例类型：clean 17，combo 65，control 9⚠，decoy 39，multi 29，single 95
一级类别：TE 30，PF 158，SA 39，TC 74，PH 2⚠，VT 45
二级子类：TE1 6⚠，TE2 6⚠，TE3 6⚠，TE4 9⚠，TE5 3⚠，PF1 31，PF2 2⚠，PF3 41，PF4 13⚠，PF5 23，PF6 0⚠，PF7 0⚠，PF8 48，SA1 0⚠，SA2 0⚠，SA3 5⚠，SA4 0⚠，SA5 8⚠，SA6 0⚠，SA7 26，TC1 16，TC2 7⚠，TC3 21，TC4 10⚠，TC5 5⚠，TC6 9⚠，TC7 6⚠，PH1 0⚠，PH2 2⚠，PH3 0⚠，PH4 0⚠，PH5 0⚠，PH6 0⚠，VT1 28，VT2 12⚠，VT3 5⚠，VT4 0⚠
发现所需证据：E1 171，E2 81，E3 74，E4 21
显著度：V1 179，V2 121，V3 48
判定依据：common_sense 151，facts 184，script 13⚠
场景：S03 25，S05 47，S07 53，S01 49，S04 35，S06 17，S02 11⚠，S08 17
多错误视频 94，其中同一连续镜头 62
未出现的子类：PF6 PF7 SA1 SA2 SA4 SA6 PH1 PH3 PH4 PH5 PH6 VT4
```
