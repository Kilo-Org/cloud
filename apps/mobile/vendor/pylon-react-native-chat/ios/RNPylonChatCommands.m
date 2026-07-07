#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(RNPylonChatCommands, NSObject)

RCT_EXTERN_METHOD(openChat)
RCT_EXTERN_METHOD(closeChat)
RCT_EXTERN_METHOD(showChatBubble)
RCT_EXTERN_METHOD(hideChatBubble)
RCT_EXTERN_METHOD(showNewMessage:(NSString *)message isHtml:(BOOL)isHtml)
RCT_EXTERN_METHOD(setNewIssueCustomFields:(NSDictionary *)fields)
RCT_EXTERN_METHOD(setTicketFormFields:(NSDictionary *)fields)
RCT_EXTERN_METHOD(updateEmailHash:(NSString *)emailHash)
RCT_EXTERN_METHOD(showTicketForm:(NSString *)slug)
RCT_EXTERN_METHOD(showKnowledgeBaseArticle:(NSString *)articleId)

@end
